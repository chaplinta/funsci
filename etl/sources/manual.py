"""Hand-curated records (philanthropy, WA Government programs) from data/manual."""
import csv

from etl.normalise import MANUAL, to_amount, to_year

NAME = "Manual"


def _read(name):
    path = MANUAL / name
    if not path.exists():
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return [r for r in csv.DictReader(f) if any((v or "").strip() for v in r.values())]


def load(samples_dir=None):
    phil = [{
        "donor": r["donor"].strip(),
        "recipient_raw": r["recipient"].strip(),
        "year": to_year(r["year"]),
        "amount_aud": to_amount(r["amount_aud"]),
        "purpose": r.get("purpose"),
        "source_url": r.get("source_url"),
    } for r in _read("philanthropy.csv")]
    wa = [{
        "program": r["program"].strip(),
        "agency": r.get("agency"),
        "recipient_raw": r["recipient"].strip(),
        "year": to_year(r["year"]),
        "amount_aud": to_amount(r["amount_aud"]),
        "purpose": r.get("purpose"),
        "source_url": r.get("source_url"),
    } for r in _read("wa_govt.csv")]
    return {"philanthropy": phil, "state_programs": wa, "url": "data/manual"}
