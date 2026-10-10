"""HTTP fetching with an on-disk cache, link discovery and spreadsheet parsing.

Government agencies publish outcomes as spreadsheets whose layout drifts year
to year, so tables are read by locating a header row and mapping columns by
synonym rather than by fixed position.
"""
import hashlib
import io
import logging
import re
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

import pandas as pd
import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "build" / "cache"
log = logging.getLogger("harvest")

# Direct spreadsheet links, plus education.gov.au style /download/.../document/xlsx.
SHEET_LINK = r"(\.(xlsx?|csv)($|\?))|(/document/(xlsx?|csv)$)"

RAW = ROOT / "data" / "raw"

# Several .gov.au sites sit behind a bot filter that stalls non-browser clients.
SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/140.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-AU,en;q=0.9",
})
TIMEOUT = (15, 60)  # connect, read
DEAD_HOSTS = set()  # hosts that timed out once go straight to the archive for the rest of the run
WAYBACK = "https://web.archive.org/web/{ts}id_/{url}"  # id_ = original bytes, no rewriting
ARCHIVE_HITS = []  # URLs served from the Internet Archive this run


def _get(url, retries):
    for attempt in range(retries):
        try:
            r = SESSION.get(url, timeout=TIMEOUT)
            r.raise_for_status()
            return r.content
        except requests.Timeout:
            raise
        except requests.RequestException as e:
            if attempt == retries - 1:
                raise
            log.warning("retry %s: %s", url, e)
            time.sleep(2 ** (attempt + 1))


def _from_archive(url, retries):
    """Latest Internet Archive snapshot of url (used when the origin blocks cloud runners)."""
    data = _get(WAYBACK.format(ts=time.strftime("%Y%m%d"), url=url), retries)
    ARCHIVE_HITS.append(url)
    log.info("archive.org copy used for %s", url)
    return data


def fetch(url, binary=False, retries=3, use_cache=True):
    if not url.startswith("http"):  # local file, e.g. data/raw/...
        data = Path(url).read_bytes()
        return data if binary else data.decode("utf-8", errors="replace")
    host = urlparse(url).hostname
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / hashlib.sha1(url.encode()).hexdigest()
    if use_cache and path.exists():
        data = path.read_bytes()
    elif host in DEAD_HOSTS:
        data = _from_archive(url, retries)
    else:
        try:
            data = _get(url, retries)
        except requests.Timeout:
            log.warning("%s timed out; using archive.org for this host", host)
            DEAD_HOSTS.add(host)
            data = _from_archive(url, retries)
        path.write_bytes(data)
    return data if binary else data.decode("utf-8", errors="replace")


def local_files(source):
    """Spreadsheets saved by hand under data/raw/<source>/ (fallback for blocked sites)."""
    d = RAW / source.lower()
    return sorted(str(p) for p in d.glob("*") if p.suffix.lower() in (".xlsx", ".xls", ".csv"))


def find_links(page_url, pattern):
    """Absolute URLs of anchors on page_url whose href matches pattern."""
    soup = BeautifulSoup(fetch(page_url), "html.parser")
    rx = re.compile(pattern, re.I)
    out = []
    for a in soup.find_all("a", href=True):
        href = urljoin(page_url, a["href"])
        if rx.search(href) and href not in out:
            out.append(href)
    return out


def _norm(s):
    return re.sub(r"[^a-z0-9]+", " ", str(s).lower()).strip()


def _score_header(cells, synonyms):
    found = set()
    for c in cells:
        n = _norm(c)
        for field, syns in synonyms.items():
            if n in syns:
                found.add(field)
    return found


def read_tables(content, synonyms, required, filename=""):
    """Yield (sheet_name, DataFrame with canonical columns) from a workbook/CSV.

    synonyms: {canonical: [header variants]}; required: canonical fields that
    must all be present for a sheet to count.
    """
    if filename.lower().endswith(".csv"):
        sheets = {"csv": pd.read_csv(io.BytesIO(content), header=None, dtype=object)}
    else:
        sheets = pd.read_excel(io.BytesIO(content), sheet_name=None, header=None, dtype=object)
    for name, raw in sheets.items():
        df = map_columns(raw, synonyms, required)
        if df is not None:
            yield name, df


def map_columns(raw, synonyms, required):
    """Find the header row in a header-less frame and return canonical columns, or None."""
    syn = {k: {_norm(v) for v in vs} for k, vs in synonyms.items()}
    for i in range(min(40, len(raw))):
        cells = list(raw.iloc[i].values)
        if not set(required) <= _score_header(cells, syn):
            continue
        cols = {}
        for j, c in enumerate(cells):
            n = _norm(c)
            for field, variants in syn.items():
                if n in variants and field not in cols:
                    cols[field] = j
        df = raw.iloc[i + 1:, list(cols.values())]
        df.columns = list(cols.keys())
        return df.dropna(how="all").reset_index(drop=True)
    return None


def html_tables(html):
    """Yield (nearest preceding heading text, header-less DataFrame) for each <table>."""
    soup = BeautifulSoup(html, "html.parser")
    for t in soup.find_all("table"):
        h = t.find_previous(["h1", "h2", "h3", "h4", "caption"])
        rows = [[c.get_text(" ", strip=True) for c in tr.find_all(["th", "td"])] for tr in t.find_all("tr")]
        rows = [r for r in rows if r]
        if rows:
            width = max(len(r) for r in rows)
            yield (h.get_text(" ", strip=True) if h else ""), pd.DataFrame([r + [None] * (width - len(r)) for r in rows])


def year_from_name(s):
    m = re.findall(r"(?<!\d)(20\d{2}|19\d{2})(?!\d)", s or "")
    return int(m[0]) if m else None
