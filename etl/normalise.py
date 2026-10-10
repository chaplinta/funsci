"""Name normalisation, organisation matching and research classification."""
import csv
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANUAL = ROOT / "data" / "manual"

STATES = {
    "WA": "WA", "WESTERN AUSTRALIA": "WA",
    "NSW": "NSW", "NEW SOUTH WALES": "NSW",
    "VIC": "VIC", "VICTORIA": "VIC",
    "QLD": "QLD", "QUEENSLAND": "QLD",
    "SA": "SA", "SOUTH AUSTRALIA": "SA",
    "TAS": "TAS", "TASMANIA": "TAS",
    "ACT": "ACT", "AUSTRALIAN CAPITAL TERRITORY": "ACT",
    "NT": "NT", "NORTHERN TERRITORY": "NT",
}

# FoR divisions (2008 two-digit 01-22, 2020 two-digit 30-52) -> broad field group.
FIELD_GROUPS = {
    "Natural sciences": {"01", "02", "03", "04", "05", "06", "07",
                         "30", "31", "34", "37", "41", "49", "51"},
    "Engineering & IT": {"08", "09", "10", "40", "46"},
    "Health & medical": {"11", "32", "42"},
}

# ARC schemes counted as investigator-initiated discovery research.
ARC_DISCOVERY_PREFIXES = ("DP", "DE", "FT", "FL", "IN", "DI", "DK")
ARC_DISCOVERY_WORDS = ("discovery", "future fellowship", "laureate")


def clean_key(s):
    s = (s or "").lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = re.sub(r"\b(the|limited|ltd|inc|incorporated)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def norm_state(s):
    if not s:
        return None
    return STATES.get(str(s).strip().upper())


class OrgIndex:
    """Maps raw organisation names onto canonical rows in `organisations`."""

    def __init__(self, conn):
        self.conn = conn
        self.alias = {}
        self.ids = {}
        with open(MANUAL / "organisations.csv", newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                oid = self._insert(row["name"], row["state"] or None, row["type"] or None)
                for a in [row["name"]] + [x for x in (row["aliases"] or "").split("|") if x]:
                    self.alias[clean_key(a)] = oid

    def _insert(self, name, state, otype):
        cur = self.conn.execute("SELECT id FROM organisations WHERE name=?", (name,))
        r = cur.fetchone()
        if r:
            return r[0]
        cur = self.conn.execute(
            "INSERT INTO organisations(name,state,type) VALUES (?,?,?)", (name, state, otype))
        return cur.lastrowid

    def match(self, raw, state=None):
        """Return (org_id, state). Unknown names become new organisations."""
        if not raw or not str(raw).strip() or str(raw).lower().startswith("various"):
            return None, norm_state(state)
        raw = str(raw).strip()
        key = clean_key(raw)
        oid = self.alias.get(key)
        if oid is None:
            # tolerate suffixes like "University of X (Faculty of Y)"
            base = clean_key(re.sub(r"\(.*?\)", "", raw))
            oid = self.alias.get(base)
        if oid is None:
            otype = "university" if "universit" in key else "other"
            oid = self._insert(raw, norm_state(state), otype)
            self.alias[key] = oid
        st = self.conn.execute("SELECT state FROM organisations WHERE id=?", (oid,)).fetchone()[0]
        if st is None and norm_state(state):
            st = norm_state(state)
            self.conn.execute("UPDATE organisations SET state=? WHERE id=?", (st, oid))
        return oid, st or norm_state(state)


def for_parts(raw):
    """'0601 - Biochemistry' or '310101' -> (code, two-digit division)."""
    if raw is None:
        return None, None
    m = re.search(r"\b(\d{2,6})\b", str(raw))
    if not m:
        return None, None
    code = m.group(1)
    if len(code) % 2:
        code = "0" + code
    return code, code[:2]


def field_group(division, default=None):
    for g, divs in FIELD_GROUPS.items():
        if division in divs:
            return g
    if division:
        return "Humanities & social sciences"
    return default


def arc_is_discovery(code, scheme):
    prefix = re.match(r"[A-Z]+", code or "")
    if prefix and prefix.group(0) in ARC_DISCOVERY_PREFIXES:
        return True
    s = (scheme or "").lower()
    return any(w in s for w in ARC_DISCOVERY_WORDS)


def to_amount(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v) if v == v else None
    s = re.sub(r"[^0-9.\-]", "", str(v))
    try:
        return float(s) if s else None
    except ValueError:
        return None


def to_year(v):
    if v is None:
        return None
    m = re.search(r"(19|20)\d{2}", str(v))
    return int(m.group(0)) if m else None
