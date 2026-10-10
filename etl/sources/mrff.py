"""Medical Research Future Fund grant recipients (Department of Health)."""
from etl.harvest import SHEET_LINK
from etl.sources.sheets import load_grant_sheets

NAME = "MRFF"
LANDING = [
    "https://www.health.gov.au/resources/publications/medical-research-future-fund-mrff-grant-recipients",
    "https://www.health.gov.au/our-work/mrff",
]
EXTRA = []


def load(samples_dir=None):
    # MRFF is mission-directed and translational; nothing is flagged as basic science.
    return load_grant_sheets(NAME, LANDING, SHEET_LINK, EXTRA,
                             default_field="Health & medical")
