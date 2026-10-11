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
                oid = self._insert(row["name"], row["state"] or None, row["type"] or None,
                                   (row.get("domain") or "").strip() or None)
                for a in [row["name"]] + [x for x in (row["aliases"] or "").split("|") if x]:
                    self.alias[clean_key(a)] = oid

    def _insert(self, name, state, otype, domain=None):
        cur = self.conn.execute("SELECT id FROM organisations WHERE name=?", (name,))
        r = cur.fetchone()
        if r:
            return r[0]
        cur = self.conn.execute(
            "INSERT INTO organisations(name,state,type,domain) VALUES (?,?,?,?)", (name, state, otype, domain))
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


# Biology topics. A grant gets a topic from its FoR code (method "for") or, failing that,
# from keywords in its title/summary (method "keyword"). FoR prefixes cover 2008 and 2020 codes.
TOPICS = {
    "Neuroscience": (("1109", "3209", "170101", "170112", "170205", "5202"),
                     r"neuro|brain|synap|cortex|cortical|neuron|glia|hippocamp|cognit|"
                     r"spinal cord|dementia|alzheimer|parkinson|epilep|axon|dendrit"),
    "Evolution": (("0603", "3104"),
                  r"evolution(?!ary algorithm)|phylogen|speciation|adaptive radiation|natural selection|"
                  r"sexual selection|macroevolution|coevolution|fossil record|ancestral state"),
    "Ecology": (("0602", "3103", "050102", "050104", "410401"),
                r"ecolog|ecosystem|biodiversity|population dynamic|food web|habitat|species distribution"),
    "Genetics & genomics": (("0604", "3105", "1103"),
                            r"genom|genetic|epigen|gene expression|gene regulat|chromosom|transcriptom|crispr"),
    "Cell & molecular biology": (("0601", "3101", "1101", "3205"),
                                 r"cell biolog|molecular biolog|biochem|enzym|organelle|mitochond|"
                                 r"signall?ing pathway|stem cell|cytoskelet|protein fold"),
    "Microbiology": (("0605", "3107", "1108"),
                     r"microb|bacteri|virus|viral|fung(?:i|al)|pathogen|antimicrobial|parasit"),
    "Plant biology": (("0607", "3108"),
                      r"\bplants?\b|photosynth|\bcrops?\b|root system|chloroplast|arabidopsis|\bwheat\b|botan"),
    "Zoology & animal biology": (("0608", "3109"),
                                 r"zoolog|animal behaviou?r|vertebrate|invertebrate|insect|marine animal|"
                                 r"mammal|\bbirds?\b|\bfish(es)?\b|reptile|amphibian|\bcorals?\b|marsupial"),
    "Physiology": (("0606", "1116", "3208"),
                   r"physiolog|metabolism|endocrin|homeosta|muscle function|cardiovascular function"),
    "Immunology": (("1107", "3204"), r"immun|antibod|\bt[- ]cells?\b|\bb[- ]cells?\b|inflammat|vaccin"),
    "Bioinformatics & computational biology": (("0802040", "080301", "3102", "460106"),
                                               r"bioinformatic|computational biolog|systems biolog|"
                                               r"mathematical model.{0,20}biolog"),
    "Structural biology & biophysics": ((), r"structural biolog|biophysic|cryo-?em|crystallograph|"
                                            r"protein structure|molecular dynamics"),
}
_TOPIC_RX = {t: re.compile(rx, re.I) for t, (_, rx) in TOPICS.items()}


def classify_topics(for_code, *texts):
    """[(topic, method)] for a grant. FoR beats keywords; several topics allowed."""
    out = {}
    code = for_code or ""
    for topic, (prefixes, _) in TOPICS.items():
        if code and any(code.startswith(p) for p in prefixes):
            out[topic] = "for"
    text = " ".join(t for t in texts if t)
    if text:
        for topic, rx in _TOPIC_RX.items():
            if topic not in out and rx.search(text):
                out[topic] = "keyword"
    return sorted(out.items())


TITLES = re.compile(
    r"\b(emeritus|professor|prof|associate|assoc|a/prof|asst|assistant|adjunct|scientia|laureate|"
    r"dr|doctor|mr|mrs|ms|miss|mx|sir|dame|hon|ao|ac|am|frs|faa|fts)\b\.?", re.I)


def clean_person(name):
    """'Prof Jane A Smith' -> 'Jane A Smith'; 'SMITH, Jane' -> 'Jane Smith'."""
    if not name or not str(name).strip():
        return None
    s = str(name).replace("A/Prof", " ").replace("A/Professor", " ")
    s = TITLES.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip(" ,;.")
    if "," in s:
        family, given = [p.strip() for p in s.split(",", 1)]
        s = f"{given} {family}".strip()
    parts = s.split()
    caps = [p for p in parts if len(p) > 1 and p.isupper()]
    if len(parts) > 1 and len(caps) == 1 and parts[0] == caps[0]:
        # 'SMITH Jane': an upper-case first token is the family name
        parts = parts[1:] + parts[:1]
    return " ".join(p if not p.isupper() or len(p) == 1 else p.title() for p in parts) or None


def person_key(name):
    """family|first-initial, lower case. Two people with the same surname and initial collide."""
    s = clean_person(name)
    if not s:
        return None
    parts = re.sub(r"[^A-Za-z' -]", "", s).split()
    if not parts:
        return None
    family = parts[-1].lower()
    initial = parts[0][0].lower() if len(parts) > 1 else ""
    return f"{family}|{initial}"
