"""NHMRC funding outcomes, from the spreadsheets on nhmrc.gov.au."""
from etl.harvest import SHEET_LINK
from etl.sources.sheets import load_grant_sheets

NAME = "NHMRC"
LANDING = [
    "https://www.nhmrc.gov.au/funding/data-research/outcomes",
    "https://www.nhmrc.gov.au/funding/data-research/outcomes-funding-rounds",
    "https://www.nhmrc.gov.au/funding/data-research/research-funding-statistics-and-data",
    "https://www.nhmrc.gov.au/funding/data-research/research-funding-data",
]
EXTRA = []


def is_basic(g):
    return "basic" in (g.get("research_area") or "").lower()


def load(samples_dir=None):
    return load_grant_sheets(NAME, LANDING, SHEET_LINK, EXTRA,
                             classify=is_basic, default_field="Health & medical")
