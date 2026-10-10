"""Cooperative Research Centres (CRC) and CRC Projects (CRC-P) grant outcomes.

Published by the Department of Industry on business.gov.au as HTML tables on
the program and selection-round-outcome pages.
"""
import logging
import re

import pandas as pd

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
    "org": GRANT_SYNONYMS["org"] + ["lead participant", "lead applicant", "applicant", "partners",
                                    "lead organisation name", "crc lead", "participant"],
    "year": GRANT_SYNONYMS["year"] + ["start end date", "start date"],
    "title": GRANT_SYNONYMS["title"] + ["crc", "crc name", "project name", "project"],
    "amount": GRANT_SYNONYMS["amount"] + ["grant funding", "commonwealth funding", "total grant amount",
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


def _first(cell):
    if not isinstance(cell, str):
        return cell
    return cell.split(" | ")[0].strip(" *,;") or None


def _centre_table(raw):
    """CRC round tables: 'Application details' cell holds name, lead and funding as text."""
    head = [str(c).lower() for c in raw.iloc[0].values]
    if not any("application details" in h for h in head):
        return None
    out = []
    for vals in raw.iloc[1:].values.tolist():
        text = " | ".join(str(v) for v in vals if v)
        parts = str(vals[0] or "").split(" | ")
        amt = re.search(r"\$\s?([\d,.]+)\s*(million|m\b)?", text, re.I)
        if not amt:
            continue
        value = float(amt.group(1).replace(",", "")) * (1e6 if amt.group(2) else 1)
        lead = re.search(r"lead(?: organisation| applicant)?:?\s*\|?\s*([^|]+)", text, re.I)
        out.append({"title": parts[0], "org": lead.group(1).strip() if lead else parts[0],
                    "amount": value})
    return pd.DataFrame(out) if out else None


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
                df = _centre_table(raw)
            if df is None:
                log.info("CRC table under '%s' not recognised; starts %s", heading[:60], describe(raw, 2))
                continue
            rnd = re.search(r"round\s*(\d+)", heading, re.I)
            scheme = f"{prog} Round {rnd.group(1)}" if rnd else prog
            year = year_from_name(heading) or year_from_name(url)
            n0 = len(rows)
            for rec in df.to_dict("records"):
                rec["scheme"] = rec.get("scheme") or scheme
                # first listed partner is the lead; cells are " | "-joined lists
                rec["org"] = _first(rec.get("org"))
                rec["title"] = (rec.get("title") or "").replace(" | ", " ") or None
                g = _row(NAME, rec, year, None, None)
                if g and g["id"] not in seen:
                    seen.add(g["id"])
                    rows.append(g)
            log.info("CRC %s '%s': %d rows", url, heading[:60], len(rows) - n0)
    if not ok:
        raise RuntimeError("CRC: no pages reachable")
    if not rows:
        raise RuntimeError("CRC: pages reached but no outcome tables recognised")
    return {"grants": rows, "url": ", ".join(PROGRAMS.values())}
