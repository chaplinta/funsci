"""Shared loader for grant-level outcomes published as spreadsheets."""
import hashlib
import logging
import re

from etl.harvest import fetch, find_links, read_tables, year_from_name
from etl.normalise import field_group, for_parts, to_amount, to_year

log = logging.getLogger("sheets")

GRANT_SYNONYMS = {
    "id": ["app id", "application id", "grant id", "app_id", "grant number", "application number",
           "grant reference", "id"],
    "scheme": ["scheme", "grant type", "funding scheme", "grant program", "program", "grant scheme",
               "initiative", "mrff initiative", "funding opportunity", "grant opportunity"],
    "subtype": ["sub type", "subtype", "grant sub type", "category", "stream"],
    "title": ["grant title", "application title", "project title", "title", "simplified title"],
    "org": ["admin institution", "administering institution", "administering organisation",
            "administering organization", "admin organisation", "institution", "organisation",
            "lead organisation", "recipient", "grant recipient", "grantee"],
    "state": ["state", "admin state", "state territory", "state or territory", "recipient state",
              "jurisdiction"],
    "lead": ["cia name", "cia", "chief investigator a", "lead investigator", "chief investigator",
             "cia full name", "lead researcher"],
    "amount": ["total", "total budget", "total amount", "amount", "funding amount",
               "total funding", "grant amount", "budget", "funding", "total grant value",
               "approved amount", "value", "total value"],
    "year": ["application year", "app year", "year", "commencement year",
             "funding commencement year", "start year", "round year", "funding year"],
    "area": ["broad research area", "research area", "broad area"],
    "for": ["field of research", "fields of research", "for", "primary for",
            "for category", "field of research code", "fields of research for"],
}


def load_grant_sheets(source, landing_pages, link_pattern, extra_urls=(),
                      classify=None, default_field=None):
    urls = list(extra_urls)
    for page in landing_pages:
        try:
            urls += [u for u in find_links(page, link_pattern) if u not in urls]
        except Exception as e:  # noqa: BLE001 - a dead landing page shouldn't stop the rest
            log.warning("%s landing page failed %s: %s", source, page, e)
    log.info("%s: %d spreadsheets", source, len(urls))
    rows, seen, files_ok = [], set(), 0
    for url in urls:
        try:
            content = fetch(url, binary=True)
            n0 = len(rows)
            for _sheet, df in read_tables(content, GRANT_SYNONYMS, ["org", "amount"], url):
                file_year = year_from_name(url)
                for rec in df.to_dict("records"):
                    g = _row(source, rec, file_year, classify, default_field)
                    if g and g["id"] not in seen:
                        seen.add(g["id"])
                        rows.append(g)
            files_ok += 1
            log.info("%s: %s -> %d rows", source, url, len(rows) - n0)
        except Exception as e:  # noqa: BLE001
            log.warning("%s file failed %s: %s", source, url, e)
    if urls and not files_ok:
        raise RuntimeError(f"{source}: no spreadsheet could be parsed")
    return {"grants": rows, "url": ", ".join(landing_pages)}


def _clean(v):
    if v is None or (isinstance(v, float) and v != v):
        return None
    s = str(v).strip()
    return s or None


def _row(source, rec, file_year, classify, default_field):
    rec = {k: _clean(v) for k, v in rec.items()}
    amount = to_amount(rec.get("amount"))
    org = rec.get("org")
    if not org or amount is None or re.match(r"(?i)^(grand )?total", org):
        return None
    year = to_year(rec.get("year")) or file_year
    gid = rec.get("id")
    if gid:
        gid = re.sub(r"\.0$", "", gid)
    else:
        gid = hashlib.sha1(f"{rec.get('title')}|{org}|{year}|{amount}".encode()).hexdigest()[:12]
    scheme = rec.get("scheme")
    if rec.get("subtype") and scheme and rec["subtype"].lower() not in scheme.lower():
        scheme = f"{scheme} - {rec['subtype']}"
    for_code, division = for_parts(rec.get("for"))
    g = {
        "id": f"{source}:{gid}",
        "source": source,
        "scheme": scheme or rec.get("subtype"),
        "round_year": year,
        "title": rec.get("title"),
        "summary": None,
        "org_raw": org,
        "state_raw": rec.get("state"),
        "lead_investigator": rec.get("lead"),
        "amount_aud": amount,
        "for_code": for_code,
        "for_division": division,
        "research_area": rec.get("area"),
        "field_group": field_group(division, default_field),
        "basic_science": 0,
    }
    if classify:
        g["basic_science"] = int(bool(classify(g)))
    return g
