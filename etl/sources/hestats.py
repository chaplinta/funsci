"""Department of Education higher education statistics: students and staff by university.

Student data: "All students by state, higher education institution and broad level of course"
(headcount; total and postgraduate by research). Staff data: FTE by state, provider and
function; academic = teaching-only + research-only + teaching-and-research.

Each year has its own page under the landing pages; spreadsheets are found by link and
tables by their title and header row, since layouts drift.
"""
import io
import logging
import re

import pandas as pd

from etl.harvest import SHEET_LINK, fetch, find_links, local_files, year_from_name
from etl.normalise import STATES, norm_state, to_amount

log = logging.getLogger("hestats")
NAME = "HEStats"
STUDENT_LANDING = "https://www.education.gov.au/higher-education-statistics/student-data"
STAFF_LANDING = "https://www.education.gov.au/higher-education-statistics/staff-data"
FIRST_YEAR = 2008
STATE_NAMES = {k for k in STATES} | {"MULTI-STATE", "MULTI STATE", "AUSTRALIA", "TABLE A", "TABLE B", "TABLE C"}


def _year_pages(landing, kind):
    try:
        links = find_links(landing, rf"/higher-education-statistics/{kind}-data/.+")
    except Exception as e:  # noqa: BLE001
        log.warning("%s landing failed: %s", kind, e)
        return []
    pages = [u for u in links if (year_from_name(u) or 0) >= FIRST_YEAR]
    log.info("%s: %d year pages", kind, len(pages))
    return pages


def _files(kind, landing, want):
    """Landing -> year pages -> resource pages -> spreadsheets. `want` picks resource pages by URL."""
    urls = local_files(f"hestats-{kind}")
    resources, all_res = [], []
    for page in [landing] + _year_pages(landing, kind):
        try:
            res = find_links(page, r"/higher-education-statistics/resources/")
        except Exception as e:  # noqa: BLE001
            log.warning("%s page failed %s: %s", kind, page, e)
            continue
        all_res += res
        for u in [r for r in res if re.search(want, r, re.I)]:
            if u not in resources and (year_from_name(u) or FIRST_YEAR) >= FIRST_YEAR:
                resources.append(u)
    log.info("%s: %d resource pages picked of %d; sample %s", kind, len(resources), len(set(all_res)),
             sorted(set(all_res))[:40])
    for page in resources:
        try:
            for u in find_links(page, SHEET_LINK):
                if u not in urls:
                    urls.append(u)
        except Exception as e:  # noqa: BLE001
            log.warning("%s resource failed %s: %s", kind, page, e)
    log.info("%s: %d candidate files: %s", kind, len(urls), urls[:10])
    return urls


def _cells(row):
    return [("" if (isinstance(v, float) and v != v) or v is None else str(v)).strip() for v in row]


def _title(raw, upto):
    return " ".join(" ".join(_cells(raw.iloc[i].values)) for i in range(min(upto, len(raw))))


def _name_cols(cells):
    """(institution column, state column or None) from a header row."""
    low = [c.lower() for c in cells]
    name = next((j for j, c in enumerate(low) if re.search(r"institution|provider", c)), 0)
    state = next((j for j, c in enumerate(low) if c == "state" and j != name), None)
    return name, state


def _rows(raw, header, cols, file_year, title, name_col=0, state_col=None):
    """Yield (org, state, year, {col: value}) below the header row.

    Older files put state headings in the name column; newer ones have a State column
    (filled on the first row of each group) next to an Institution column.
    """
    year = year_from_name(title) or file_year
    state = None
    for i in range(header + 1, len(raw)):
        cells = _cells(raw.iloc[i].values)
        if state_col is not None and state_col < len(cells) and cells[state_col]:
            st = cells[state_col].upper().strip(" :*")
            if re.search(r"(?i)total", st):
                continue
            state = norm_state(st) or state
        name = cells[name_col] if name_col < len(cells) else ""
        if not name:
            continue
        up = name.upper().strip(" :*")
        if norm_state(up) or up in STATE_NAMES:
            state = norm_state(up)
            continue
        if re.match(r"(?i)(total|grand total|all |sub-?total|note|source|\*|#|\(|<)", name) or re.search(r"(?i)\btotal\b", name):
            continue
        vals = {k: to_amount(cells[j]) if j < len(cells) else None for k, j in cols.items()}
        if all(v is None for v in vals.values()):
            continue
        yield re.sub(r"\s*\(.*?\)\s*$|\s*[*#^]+$", "", name).strip(), state, year, vals


def parse_students(content, url):
    out = []
    for sheet, raw in pd.read_excel(io.BytesIO(content), sheet_name=None, header=None, dtype=object).items():
        title = _title(raw, 6).lower()
        # only the headcount by broad level of course table carries the research-student column
        if not ("all students" in title and ("institution" in title or "provider" in title)
                and "level of course" in title) or "commencing" in title or "load" in title:
            continue
        for h in range(min(30, len(raw))):
            cells = [c.lower() for c in _cells(raw.iloc[h].values)]
            hdr = next((j for j, c in enumerate(cells) if re.search(r"postgraduate by research|higher degree by research", c)), None)
            tot = max((j for j, c in enumerate(cells) if re.fullmatch(r"(grand )?total", c)), default=None)
            if tot is not None:
                cols = {"students": tot}
                if hdr is not None:
                    cols["hdr"] = hdr
                nc, sc = _name_cols(_cells(raw.iloc[h].values))
                rows = list(_rows(raw, h, cols, year_from_name(url), title, nc, sc))
                log.info("students %s / %s: %d universities", url[-60:], sheet, len(rows))
                out += [(o, st, y, v["students"], v.get("hdr")) for o, st, y, v in rows if y]
                break
        else:
            log.info("students %s / %s: title matched, no header found; starts %s", url[-60:], sheet, _title(raw, 8)[:300])
    return out


def parse_staff(content, url):
    best = []
    for sheet, raw in pd.read_excel(io.BytesIO(content), sheet_name=None, header=None, dtype=object).items():
        title = _title(raw, 6).lower()
        if "function" not in title or ("institution" not in title and "provider" not in title):
            continue
        for h in range(min(30, len(raw))):
            cells = [c.lower() for c in _cells(raw.iloc[h].values)]
            ro = next((j for j, c in enumerate(cells) if re.search(r"research[- ]only", c)), None)
            tr = next((j for j, c in enumerate(cells) if re.search(r"teaching[- ]and[- ]research", c)), None)
            to = next((j for j, c in enumerate(cells) if re.search(r"teaching[- ]only", c)), None)
            if ro is not None and tr is not None:
                cols = {"ro": ro, "tr": tr}
                if to is not None:
                    cols["to"] = to
                nc, sc = _name_cols(_cells(raw.iloc[h].values))
                rows = [(o, st, y, sum(v[k] or 0 for k in cols), v["ro"]) for o, st, y, v in
                        _rows(raw, h, cols, year_from_name(url), title, nc, sc) if y]
                log.info("staff %s / %s (%s): %d universities", url[-60:], sheet, title[:90], len(rows))
                # prefer the table that includes casual staff, which is the usual headline FTE
                if rows and ("casual" in title or not best):
                    best = rows
                break
    if not best:
        log.info("staff %s: no FTE-by-function table", url[-60:])
    return best


def load(samples_dir=None):
    students, staff = [], []
    for url in _files("student", STUDENT_LANDING, r"section-?2\b|section-2-|all-students|student-summary-time-series"):
        try:
            students += parse_students(fetch(url, binary=True), url)
        except Exception as e:  # noqa: BLE001
            log.warning("student file failed %s: %s", url, e)
    for url in _files("staff", STAFF_LANDING, r"staff|fte"):
        try:
            staff += parse_staff(fetch(url, binary=True), url)
        except Exception as e:  # noqa: BLE001
            log.warning("staff file failed %s: %s", url, e)
    log.info("HEStats: %d student rows (%d years), %d staff rows (%d years)",
             len(students), len({r[2] for r in students}), len(staff), len({r[2] for r in staff}))
    if not students and not staff:
        raise RuntimeError("no student or staff tables parsed")
    return {"student_stats": students, "staff_stats": staff, "url": f"{STUDENT_LANDING}, {STAFF_LANDING}"}
