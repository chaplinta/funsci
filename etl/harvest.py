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
from urllib.parse import urljoin

import pandas as pd
import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "build" / "cache"
log = logging.getLogger("harvest")

# Direct spreadsheet links, plus education.gov.au style /download/.../document/xlsx.
SHEET_LINK = r"(\.(xlsx?|csv)($|\?))|(/document/(xlsx?|csv)$)"

SESSION = requests.Session()
SESSION.headers["User-Agent"] = (
    "funsci-research-funding-explorer/1.0 (+https://github.com/chaplinta/funsci)")


def fetch(url, binary=False, retries=3, use_cache=True):
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / hashlib.sha1(url.encode()).hexdigest()
    if use_cache and path.exists():
        data = path.read_bytes()
    else:
        for attempt in range(retries):
            try:
                r = SESSION.get(url, timeout=120)
                r.raise_for_status()
                data = r.content
                break
            except requests.RequestException as e:
                if attempt == retries - 1:
                    raise
                log.warning("retry %s: %s", url, e)
                time.sleep(2 ** (attempt + 1))
        path.write_bytes(data)
    return data if binary else data.decode("utf-8", errors="replace")


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
    syn = {k: {_norm(v) for v in vs} for k, vs in synonyms.items()}
    if filename.lower().endswith(".csv"):
        sheets = {"csv": pd.read_csv(io.BytesIO(content), header=None, dtype=object)}
    else:
        sheets = pd.read_excel(io.BytesIO(content), sheet_name=None, header=None, dtype=object)
    for name, raw in sheets.items():
        for i in range(min(40, len(raw))):
            cells = list(raw.iloc[i].values)
            found = _score_header(cells, syn)
            if not set(required) <= found:
                continue
            cols = {}
            for j, c in enumerate(cells):
                n = _norm(c)
                for field, variants in syn.items():
                    if n in variants and field not in cols:
                        cols[field] = j
            df = raw.iloc[i + 1:, list(cols.values())]
            df.columns = list(cols.keys())
            df = df.dropna(how="all")
            yield name, df.reset_index(drop=True)
            break


def year_from_name(s):
    m = re.findall(r"(?<!\d)(20\d{2}|19\d{2})(?!\d)", s or "")
    return int(m[0]) if m else None
