"""Build the funding database from every source.

    python -m etl.run [--previous old.sqlite] [--only ARC,NHMRC] [--out build]

Each source is independent. If one fails and --previous is given, that
source's rows are carried over from the previous database so a broken
upstream page never empties the site.
"""
import argparse
import datetime as dt
import gzip
import hashlib
import importlib
import json
import logging
import shutil
import sqlite3
from pathlib import Path

from etl import harvest
from collections import Counter

from etl.normalise import OrgIndex, classify_topics, clean_person, is_person, person_key

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ["abs", "arc", "nhmrc", "mrff", "crc", "education", "manual"]
log = logging.getLogger("run")
REJECTED = Counter()  # non-person "investigator" names seen this build

GRANT_COLS = ["id", "source", "scheme", "round_year", "title", "summary", "org_id", "org_raw",
              "state", "lead_investigator", "lead_raw", "amount_aud", "for_code", "for_division",
              "research_area", "field_group", "basic_science"]


def insert(conn, orgs, data):
    n = 0
    for g in data.get("grants", []):
        oid, state = orgs.match(g["org_raw"], g.get("state_raw"))
        lead = g.get("lead_investigator")
        if lead and not is_person(lead):
            REJECTED[str(lead).strip()] += 1
        g = {**g, "org_id": oid, "state": state, "lead_raw": g.get("lead_raw", lead),
             "lead_investigator": lead if is_person(lead) else None}
        conn.execute(f"INSERT OR REPLACE INTO grants({','.join(GRANT_COLS)}) "
                     f"VALUES ({','.join('?' * len(GRANT_COLS))})", [g.get(c) for c in GRANT_COLS])
        insert_links(conn, g)
        n += 1
    for org, year, program, amt in data.get("block_grants", []):
        oid, _ = orgs.match(org)
        conn.execute("INSERT OR REPLACE INTO block_grants VALUES (?,?,?,?)", (oid, year, program, amt))
        n += 1
    for org, year, cat, amt in data.get("research_income", []):
        oid, _ = orgs.match(org)
        conn.execute("INSERT OR REPLACE INTO research_income VALUES (?,?,?,?)", (oid, year, cat, amt))
        n += 1
    for st, year, persons in data.get("population", []):
        conn.execute("INSERT OR REPLACE INTO population VALUES (?,?,?)", (st, year, persons))
        n += 1
    for year, idx in data.get("cpi", []):
        conn.execute("INSERT OR REPLACE INTO cpi VALUES (?,?)", (year, idx))
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


def insert_links(conn, g):
    """Topic tags and investigator rows for one grant."""
    gid = g["id"]
    conn.execute("DELETE FROM grant_topics WHERE grant_id=?", (gid,))
    conn.execute("DELETE FROM investigators WHERE grant_id=?", (gid,))
    for topic, method in classify_topics(g.get("for_code"), g.get("title"), g.get("summary")):
        conn.execute("INSERT INTO grant_topics VALUES (?,?,?)", (gid, topic, method))
    people = g.get("investigators") or []
    if g.get("lead_investigator") and not any(r == "lead" for _, r in people):
        people = [(g["lead_investigator"], "lead")] + list(people)
    for raw, _ in people:
        if raw and not is_person(raw) and raw != g.get("lead_raw"):
            REJECTED[str(raw).strip()] += 1
    people = [(raw, role, person_key(raw)) for raw, role in people]
    people = [p for p in people if p[2]]
    n = len({k for _, _, k in people})
    share = g["amount_aud"] / n if n and g.get("amount_aud") is not None else None
    conn.execute("UPDATE grants SET team_size=? WHERE id=?", (n or None, gid))
    for raw, role, key in people:
        conn.execute("INSERT OR IGNORE INTO investigators VALUES (?,?,?,?,?)",
                     (gid, clean_person(raw), key, role, share))


def carry_over(conn, orgs, prev, name):
    """Re-load a failed source's rows from the previous database."""
    old = sqlite3.connect(prev)
    old.row_factory = sqlite3.Row
    orgname = "(SELECT name FROM organisations o WHERE o.id=t.org_id)"
    data = {}
    if name in ("ARC", "NHMRC", "MRFF", "CRC"):
        have = {r[1] for r in old.execute("PRAGMA table_info(grants)")}  # older DBs lack newer columns
        cols = [c for c in GRANT_COLS if c not in ("org_id", "state") and c in have]
        rows = old.execute(f"SELECT {','.join(cols)}, state AS state_raw FROM grants t "
                           "WHERE source=?", (name,)).fetchall()
        data["grants"] = [dict(r) for r in rows]
        team = {}
        try:
            for gid, nm, role in old.execute("SELECT i.grant_id, i.name, i.role FROM investigators i "
                                             "JOIN grants g ON g.id=i.grant_id WHERE g.source=?", (name,)):
                team.setdefault(gid, []).append((nm, role))
        except sqlite3.OperationalError:  # previous DB predates the investigators table
            pass
        for g in data["grants"]:
            g["investigators"] = team.get(g["id"])
    elif name == "ABS":
        try:
            data["population"] = [tuple(r) for r in old.execute("SELECT state, year, persons FROM population")]
            data["cpi"] = [tuple(r) for r in old.execute("SELECT year, idx FROM cpi")]
        except sqlite3.OperationalError:
            pass
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
            if n == 0:
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
    if REJECTED:
        log.info("not people (%d names, %d uses), top 30: %s", len(REJECTED), sum(REJECTED.values()),
                 REJECTED.most_common(30))
    conn.execute("VACUUM")
    conn.close()
    return db


def shard(grant_id):
    """Summary shard file for a grant id: first two hex digits of its SHA-1 (site/app.js mirrors this)."""
    return hashlib.sha1(grant_id.encode()).hexdigest()[:2]


def write_summaries(db, out_dir):
    """Grant summaries as 256 small JSON files, fetched one at a time by the detail view."""
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    shards = {}
    c = sqlite3.connect(db)
    for gid, summary in c.execute("SELECT id, summary FROM grants WHERE summary IS NOT NULL AND summary <> ''"):
        shards.setdefault(shard(gid), {})[gid] = summary
    c.close()
    for key, items in shards.items():
        (out_dir / f"{key}.json").write_text(json.dumps(items, ensure_ascii=False, separators=(",", ":")))
    return sum(len(v) for v in shards.values())


def publish(db, site_data):
    """Lite DB for the browser (no long summaries), summary shards, and gzipped full DB."""
    site_data.mkdir(parents=True, exist_ok=True)
    write_summaries(db, site_data / "summaries")
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
    from etl import analysis
    _, md = analysis.run(db, Path(args.site_data), Path(args.out) / "analysis.md")
    log.info("analysis report:\n%s", md)


if __name__ == "__main__":
    main()
