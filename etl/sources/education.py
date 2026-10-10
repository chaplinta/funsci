"""Department of Education: Research Block Grant allocations and HERDC income."""
import logging
import re

from etl.harvest import SHEET_LINK, fetch, find_links, read_tables, year_from_name
from etl.normalise import to_amount, to_year

log = logging.getLogger("education")
NAME = "Education"

RBG_LANDING = [
    "https://www.education.gov.au/node/17511",  # RBG allocations time series
    "https://www.education.gov.au/resources/research-block-grants",
]
HERDC_LANDING = [
    "https://www.education.gov.au/node/3974",  # research and development income time series
    "https://www.education.gov.au/research-block-grants/higher-education-research-data-collection-herdc",
]
RBG_EXTRA, HERDC_EXTRA = [], []

INST = ["institution", "higher education provider", "provider", "university", "heps",
        "higher education institution", "institution name"]
RBG_SYN = {
    "org": INST,
    "year": ["year", "allocation year", "funding year"],
    "RTP": ["rtp", "research training program", "research training program rtp", "rtp allocation"],
    "RSP": ["rsp", "research support program", "research support program rsp", "rsp allocation"],
}
HERDC_SYN = {
    "org": INST,
    "year": ["year", "reference year", "collection year"],
    "Cat 1": ["category 1", "cat 1", "category 1 australian competitive grants",
              "australian competitive grants", "cat1"],
    "Cat 2": ["category 2", "cat 2", "other public sector research income",
              "other public sector research funding", "cat2"],
    "Cat 3": ["category 3", "cat 3", "industry and other research income",
              "industry and other research funding", "cat3"],
    "Cat 4": ["category 4", "cat 4", "cooperative research centre research income",
              "crc research income", "cat4"],
    "Total": ["total", "total research income", "grand total"],
}


def _links(pages, extra):
    urls = list(extra)
    for p in pages:
        try:
            urls += [u for u in find_links(p, SHEET_LINK) if u not in urls]
        except Exception as e:  # noqa: BLE001
            log.warning("landing page failed %s: %s", p, e)
    return urls


def _long(df, value_cols, file_year):
    for rec in df.to_dict("records"):
        org = rec.get("org")
        if not isinstance(org, str) or not org.strip() or re.match(r"(?i)\s*(grand )?total", org):
            continue
        year = to_year(rec.get("year")) or file_year
        if not year:
            continue
        for col in value_cols:
            amt = to_amount(rec.get(col))
            if amt is not None:
                yield org.strip(), year, col, amt


def _harvest(pages, extra, syn, value_cols, label):
    out, ok = [], 0
    urls = _links(pages, extra)
    for url in urls:
        try:
            content = fetch(url, binary=True)
            for sheet, df in read_tables(content, syn, ["org"], url):
                present = [c for c in value_cols if c in df.columns]
                if not present:
                    continue
                fy = year_from_name(url) or year_from_name(str(sheet))
                out += list(_long(df, present, fy))
            ok += 1
        except Exception as e:  # noqa: BLE001
            log.warning("%s file failed %s: %s", label, url, e)
    log.info("%s: %d files, %d values", label, len(urls), len(out))
    if urls and not ok:
        raise RuntimeError(f"{label}: no spreadsheet could be parsed")
    return out


def load(samples_dir=None):
    blocks = _harvest(RBG_LANDING, RBG_EXTRA, RBG_SYN, ["RTP", "RSP"], "RBG")
    income = _harvest(HERDC_LANDING, HERDC_EXTRA, HERDC_SYN,
                      ["Cat 1", "Cat 2", "Cat 3", "Cat 4", "Total"], "HERDC")
    return {"block_grants": blocks, "research_income": income,
            "url": ", ".join(RBG_LANDING + HERDC_LANDING)}
