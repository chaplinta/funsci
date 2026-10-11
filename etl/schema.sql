-- Normalised schema for Australian research funding data.
CREATE TABLE IF NOT EXISTS organisations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,          -- canonical name
  state TEXT,                         -- WA, NSW, ...
  type TEXT                           -- university | institute | govt | hospital | other
);

CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,                -- source-prefixed, e.g. ARC:DP200100001
  source TEXT NOT NULL,               -- ARC | NHMRC | MRFF | WA
  scheme TEXT,
  round_year INTEGER,                 -- year of funding round / commencement
  title TEXT,
  summary TEXT,
  org_id INTEGER REFERENCES organisations(id),
  org_raw TEXT,
  state TEXT,
  lead_investigator TEXT,
  amount_aud REAL,
  for_code TEXT,                      -- most specific FoR code given
  for_division TEXT,                  -- 2-digit FoR division
  research_area TEXT,                 -- NHMRC broad research area etc.
  field_group TEXT,                   -- Natural sciences | Engineering & IT | Health & medical | HASS
  basic_science INTEGER NOT NULL DEFAULT 0,
  team_size INTEGER                   -- distinct people named (ARC: all CIs; others: lead only)
);
CREATE INDEX IF NOT EXISTS grants_year ON grants(round_year);
CREATE INDEX IF NOT EXISTS grants_state ON grants(state);
CREATE INDEX IF NOT EXISTS grants_org ON grants(org_id);

CREATE TABLE IF NOT EXISTS block_grants (
  org_id INTEGER REFERENCES organisations(id),
  year INTEGER,
  program TEXT,                       -- RTP | RSP | other
  amount_aud REAL,
  PRIMARY KEY (org_id, year, program)
);

CREATE TABLE IF NOT EXISTS research_income (
  org_id INTEGER REFERENCES organisations(id),
  year INTEGER,
  category TEXT,                      -- HERDC Cat 1..4
  amount_aud REAL,
  PRIMARY KEY (org_id, year, category)
);

CREATE TABLE IF NOT EXISTS philanthropy (
  donor TEXT,
  org_id INTEGER REFERENCES organisations(id),
  recipient_raw TEXT,
  year INTEGER,
  amount_aud REAL,
  purpose TEXT,
  source_url TEXT
);

CREATE TABLE IF NOT EXISTS state_programs (
  program TEXT,
  agency TEXT,
  org_id INTEGER REFERENCES organisations(id),
  recipient_raw TEXT,
  year INTEGER,
  amount_aud REAL,
  purpose TEXT,
  source_url TEXT
);

CREATE TABLE IF NOT EXISTS sources (
  name TEXT PRIMARY KEY,
  url TEXT,
  fetched_at TEXT,
  rows INTEGER,
  status TEXT,                        -- ok | failed | cached
  note TEXT
);

-- Biology topics per grant (several allowed). method: for (FoR code) | keyword (title/summary)
CREATE TABLE IF NOT EXISTS grant_topics (
  grant_id TEXT REFERENCES grants(id),
  topic TEXT,
  method TEXT,
  PRIMARY KEY (grant_id, topic)
);
CREATE INDEX IF NOT EXISTS grant_topics_topic ON grant_topics(topic);

-- People named on grants. name_key = family|first-initial, so matching is by name only.
CREATE TABLE IF NOT EXISTS investigators (
  grant_id TEXT REFERENCES grants(id),
  name TEXT,
  name_key TEXT,
  role TEXT,                          -- lead | CI | PI ...
  share_aud REAL,                     -- grant amount / number of distinct people named on the grant
  PRIMARY KEY (grant_id, name_key, role)
);
CREATE INDEX IF NOT EXISTS investigators_key ON investigators(name_key);

-- ABS estimated resident population (June) and CPI (annual average index), for per-capita and real dollars.
CREATE TABLE IF NOT EXISTS population (state TEXT, year INTEGER, persons REAL, PRIMARY KEY (state, year));
CREATE TABLE IF NOT EXISTS cpi (year INTEGER PRIMARY KEY, idx REAL);
