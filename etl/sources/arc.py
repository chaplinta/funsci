"""ARC National Competitive Grants Program, via the ARC Data Portal JSON:API."""
import json
import logging
from pathlib import Path

from etl.harvest import fetch
from etl.normalise import arc_is_discovery, field_group, for_parts, to_amount, to_year

log = logging.getLogger("arc")
API = "https://dataportal.arc.gov.au/NCGP/API/grants"
PAGE_SIZE = 1000
NAME = "ARC"


def pick(d, *keys):
    for k in keys:
        v = d.get(k)
        if v not in (None, "", []):
            return v
    return None


def parse_grant(item):
    a = item.get("attributes", {})
    code = item.get("id") or a.get("code")
    scheme_info = a.get("scheme-information") or {}
    scheme = pick(a, "scheme-name") or pick(scheme_info, "schemeShortName", "scheme-name")
    org = pick(a, "current-admin-organisation", "announcement-admin-organisation",
               "administering-organisation", "admin-organisation")
    year = to_year(pick(a, "funding-commencement-year", "commencement-year")
                   or pick(scheme_info, "fundingCommencementYear", "campaign"))
    amount = to_amount(pick(a, "current-funding-amount", "announced-funding-amount",
                            "funding-amount"))
    for_raw = pick(a, "primary-field-of-research", "field-of-research")
    if isinstance(for_raw, list):
        for_raw = for_raw[0]
    if isinstance(for_raw, dict):
        for_raw = pick(for_raw, "code", "name")
    for_code, division = for_parts(for_raw)
    lead = pick(a, "lead-investigator")
    if isinstance(lead, dict):
        lead = pick(lead, "name", "full-name")
    return {
        "id": f"ARC:{code}",
        "source": "ARC",
        "scheme": scheme,
        "round_year": year,
        "title": pick(a, "grant-title", "project-title", "title"),
        "summary": pick(a, "grant-summary", "national-interest-test-statement"),
        "org_raw": org,
        "state_raw": None,
        "lead_investigator": lead,
        "amount_aud": amount,
        "for_code": for_code,
        "for_division": division,
        "research_area": None,
        "field_group": field_group(division),
        "basic_science": int(arc_is_discovery(code, scheme)),
    }


def load(samples_dir=None):
    url = f"{API}?page%5Bsize%5D={PAGE_SIZE}&page%5Bnumber%5D=1"
    rows, page = [], 1
    while url:
        doc = json.loads(fetch(url, use_cache=False))
        if samples_dir and page == 1:
            Path(samples_dir, "arc_page1.json").write_text(
                json.dumps({**doc, "data": doc.get("data", [])[:3]}, indent=2))
        data = doc.get("data", [])
        rows.extend(parse_grant(d) for d in data)
        nxt = (doc.get("links") or {}).get("next")
        pages = (doc.get("meta") or {}).get("total-pages")
        if not nxt and pages and page < int(pages):
            nxt = f"{API}?page%5Bsize%5D={PAGE_SIZE}&page%5Bnumber%5D={page + 1}"
        log.info("ARC page %d: %d grants (total %d)", page, len(data), len(rows))
        if not data or not nxt or nxt == url:
            break
        url, page = nxt, page + 1
    return {"grants": rows, "url": API}
