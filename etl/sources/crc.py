"""Cooperative Research Centres (CRC) and CRC Projects (CRC-P) grant outcomes.

Published by the Department of Industry on business.gov.au as HTML tables on
the program and selection-round-outcome pages.
"""
import logging
import re

from etl.harvest import describe, fetch, find_links, html_tables, map_columns, year_from_name
from etl.sources.sheets import GRANT_SYNONYMS, _row

log = logging.getLogger("crc")
NAME = "CRC"
PROGRAMS = {
    "CRC-P": "https://business.gov.au/grants-and-programs/cooperative-research-centres-projects-crcp-grants",
    "CRC": "https://business.gov.au/grants-and-programs/cooperative-research-centres-crc-grants",
}
EXTRA = []

SYN = {
    **GRANT_SYNONYMS,
    "org": GRANT_SYNONYMS["org"] + ["lead participant", "lead applicant", "applicant",
                                    "lead organisation name", "crc lead", "participant"],
    "title": GRANT_SYNONYMS["title"] + ["crc", "crc name", "project name", "project"],
    "amount": GRANT_SYNONYMS["amount"] + ["grant funding", "commonwealth funding",
                                          "grant amount gst exclusive", "funding gst exclusive",
                                          "grant funding gst exclusive", "commonwealth funding gst exclusive"],
}


def _pages():
    pages = list(EXTRA)
    for prog, url in PROGRAMS.items():
        pages.append((prog, url))
        try:
            for link in find_links(url, r"outcome|recipient|funded|successful"):
                if (prog, link) not in pages:
                    pages.append((prog, link))
        except Exception as e:  # noqa: BLE001
            log.warning("CRC program page failed %s: %s", url, e)
    return pages


def load(samples_dir=None):
    rows, seen, ok = [], set(), 0
    pages = _pages()
    for prog, url in pages:
        try:
            html = fetch(url)
        except Exception as e:  # noqa: BLE001
            log.warning("CRC page failed %s: %s", url, e)
            continue
        ok += 1
        tables = list(html_tables(html))
        log.info("CRC %s: %d tables", url, len(tables))
        for heading, raw in tables:
            df = map_columns(raw, SYN, ["org", "amount"])
            if df is None:
                # centre tables may list only the CRC itself; credit the centre
                df = map_columns(raw, SYN, ["title", "amount"])
                if df is None:
                    log.info("CRC table under '%s' not recognised; starts %s", heading[:60], describe(raw, 2))
                    continue
                df["org"] = df["title"]
            rnd = re.search(r"round\s*(\d+)", heading, re.I)
            scheme = f"{prog} Round {rnd.group(1)}" if rnd else prog
            year = year_from_name(heading) or year_from_name(url)
            n0 = len(rows)
            for rec in df.to_dict("records"):
                rec.setdefault("scheme", scheme)
                rec["scheme"] = rec.get("scheme") or scheme
                g = _row(NAME, rec, year, None, None)
                if g and g["id"] not in seen:
                    seen.add(g["id"])
                    rows.append(g)
            log.info("CRC %s '%s': %d rows", url, heading[:60], len(rows) - n0)
    if not ok:
        raise RuntimeError("CRC: no pages reachable")
    return {"grants": rows, "url": ", ".join(PROGRAMS.values())}
