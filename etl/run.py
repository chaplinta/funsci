"""Build the funding database from every source.

    python -m etl.run [--previous old.sqlite] [--only ARC,NHMRC] [--out build]

Each source is independent. If one fails and --previous is given, that
source's rows are carried over from the previous database so a broken
upstream page never empties the site.
"""
import argparse
import datetime as dt
import gzip
import importlib
import json
import logging
import shutil
import sqlite3
from pathlib import Path

from etl import harvest
from etl.normalise import OrgIndex

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ["arc", "nhmrc", "mrff", "crc", "education", "manual"]
log = logging.getLogger("run")

GRANT_COLS = ["id", "source", "scheme", "round_year", "title", "summary", "org_id", "org_raw",
              "state", "lead_investigator", "amount_aud", "for_code", "for_division",
              "research_area", "field_group", "basic_science"]


def insert(conn, orgs, data):
    n = 0
    for g in data.get("grants", []):
        oid, state = orgs.match(g["org_raw"], g.get("state_raw"))
        g = {**g, "org_id": oid, "state": state}
        conn.execute(f"INSERT OR REPLACE INTO grants({','.join(GRANT_COLS)}) "
                     f"VALUES ({','.join('?' * len(GRANT_COLS))})", [g.get(c) for c in GRANT_COLS])
        n += 1
    for org, year, program, amt in data.get("block_grants", []):
        oid, _ = orgs.match(org)
        conn.execute("INSERT OR REPLACE INTO block_grants VALUES (?,?,?,?)", (oid, year, program, amt))
        n += 1
    for org, year, cat, amt in data.get("research_income", []):
        oid, _ = orgs.match(org)
        conn.execute("INSERT OR REPLACE INTO research_income VALUES (?,?,?,?)", (oid, year, cat, amt))
        n += 1
    for p in data.get("philanthropy", []):
        oid, _ = orgs.match(p["recipient_raw"])
        conn.execute("INSERT INTO philanthropy VALUES (?,?,?,?,?,?,?)",
                     (p["donor"], oid, p["recipient_raw"], p["year"], p["amount_aud"],
                      p["purpose"], p["source_url"]))
        n += 1
    for p in data.get("state_programs", []):
        oid, _ = orgs.match(p["recipient_raw"], "WA")
        conn.execute("INSERT INTO state_programs VALUES (?,?,?,?,?,?,?,?)",
                     (p["program"], p["agency"], oid, p["recipient_raw"], p["year"],
                      p["amount_aud"], p["purpose"], p["source_url"]))
        n += 1
    return n


def carry_over(conn, orgs, prev, name):
    """Re-load a failed source's rows from the previous database."""
    old = sqlite3.connect(prev)
    old.row_factory = sqlite3.Row
    orgname = "(SELECT name FROM organisations o WHERE o.id=t.org_id)"
    data = {}
    if name in ("ARC", "NHMRC", "MRFF", "CRC"):
        cols = [c for c in GRANT_COLS if c not in ("org_id", "state")]
        rows = old.execute(f"SELECT {','.join(cols)}, state AS state_raw FROM grants t "
                           "WHERE source=?", (name,)).fetchall()
        data["grants"] = [dict(r) for r in rows]
    elif name == "Education":
        data["block_grants"] = [tuple(r) for r in old.execute(
            f"SELECT {orgname}, year, program, amount_aud FROM block_grants t")]
        data["research_income"] = [tuple(r) for r in old.execute(
            f"SELECT {orgname}, year, category, amount_aud FROM research_income t")]
    old.close()
    return insert(conn, orgs, data)


def build(out, previous=None, only=None):
    out.mkdir(parents=True, exist_ok=True)
    samples = out / "samples"
    samples.mkdir(exist_ok=True)
    db = out / "funding.sqlite"
    db.unlink(missing_ok=True)
    conn = sqlite3.connect(db)
    conn.executescript((ROOT / "etl" / "schema.sql").read_text())
    orgs = OrgIndex(conn)
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    for modname in SOURCES:
        mod = importlib.import_module(f"etl.sources.{modname}")
        if only and mod.NAME not in only:
            continue
        harvest.ARCHIVE_HITS.clear()
        try:
            data = mod.load(samples_dir=samples)
            n = insert(conn, orgs, data)
            status, note, url = "ok", None, data.get("url")
            if harvest.ARCHIVE_HITS:
                note = f"{len(harvest.ARCHIVE_HITS)} file(s) via web.archive.org (origin blocked)"
            if n == 0 and previous:
                raise RuntimeError("source returned no rows")
        except Exception as e:  # noqa: BLE001
            log.exception("%s failed", mod.NAME)
            url, note = None, f"{type(e).__name__}: {e}"[:500]
            if previous and Path(previous).exists():
                n, status = carry_over(conn, orgs, previous, mod.NAME), "cached"
            else:
                n, status = 0, "failed"
        conn.execute("INSERT OR REPLACE INTO sources VALUES (?,?,?,?,?,?)",
                     (mod.NAME, url, now, n, status, note))
        conn.commit()
        log.info("%s: %s, %d rows", mod.NAME, status, n)
    conn.execute("VACUUM")
    conn.close()
    return db


def publish(db, site_data):
    """Lite DB for the browser (no long summaries) plus gzipped full DB."""
    site_data.mkdir(parents=True, exist_ok=True)
    lite = site_data / "funding.sqlite"
    shutil.copy(db, lite)
    c = sqlite3.connect(lite)
    c.execute("UPDATE grants SET summary=NULL")
    c.commit()
    c.execute("VACUUM")
    meta = {
        "built": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "sources": [dict(zip(["name", "url", "fetched_at", "rows", "status", "note"], r))
                    for r in c.execute("SELECT * FROM sources")],
    }
    c.close()
    with open(db, "rb") as src, gzip.open(site_data / "funding-full.sqlite.gz", "wb") as dst:
        shutil.copyfileobj(src, dst)
    (site_data / "meta.json").write_text(json.dumps(meta, indent=2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "build"))
    ap.add_argument("--previous")
    ap.add_argument("--only", help="comma-separated source names")
    ap.add_argument("--site-data", default=str(ROOT / "site" / "data"))
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    db = build(Path(args.out), args.previous, args.only.split(",") if args.only else None)
    publish(db, Path(args.site_data))


if __name__ == "__main__":
    main()
