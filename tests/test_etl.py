import io
import json
import sqlite3
from pathlib import Path

import pandas as pd
import pytest

from etl import harvest, run
from etl.normalise import for_parts, field_group, arc_is_discovery, to_amount
from etl.sources import arc, sheets, education

FIX = Path(__file__).parent / "fixtures"


def xlsx(frames):
    buf = io.BytesIO()
    with pd.ExcelWriter(buf) as w:
        for name, df in frames.items():
            df.to_excel(w, sheet_name=name, index=False, header=False)
    return buf.getvalue()


NHMRC_SHEET = pd.DataFrame([
    ["NHMRC 2023 outcomes", None, None, None, None, None, None],
    ["APP ID", "Grant Type", "CIA Name", "Admin Institution", "State",
     "Broad Research Area", "Total"],
    [2001234, "Ideas Grants", "Dr A", "Harry Perkins Institute", "WA", "Basic Science", "1,234,567"],
    [2001235, "Ideas Grants", "Dr B", "Monash University", "VIC", "Public Health", 800000],
    [None, None, None, "Grand Total", None, None, 2034567],
])


@pytest.fixture
def offline(monkeypatch, tmp_path):
    files = {
        "https://x/nhmrc-2023.xlsx": xlsx({"Grants": NHMRC_SHEET}),
        "https://x/rbg-2024.xlsx": xlsx({"2024": pd.DataFrame([
            ["Institution", "RTP", "RSP"],
            ["Curtin University", 30000000, 25000000],
            ["Total", 1, 1]])}),
        "https://x/herdc.xlsx": xlsx({"income": pd.DataFrame([
            ["Institution", "Year", "Category 1", "Category 2", "Category 3", "Category 4"],
            ["University of Western Australia", 2022, 100, 50, 20, 0]])}),
    }
    arc_json = (FIX / "arc_page.json").read_text()

    def fake_fetch(url, binary=False, **_):
        if "dataportal.arc" in url:
            return arc_json
        return files[url]

    def fake_links(page, pattern):
        return {"nhmrc": ["https://x/nhmrc-2023.xlsx"],
                "rbg": ["https://x/rbg-2024.xlsx"],
                "herdc": ["https://x/herdc.xlsx"]}[page]

    for mod in (harvest, arc, sheets, education):
        if hasattr(mod, "fetch"):
            monkeypatch.setattr(mod, "fetch", fake_fetch)
        if hasattr(mod, "find_links"):
            monkeypatch.setattr(mod, "find_links", fake_links)
    from etl.sources import nhmrc, mrff, crc
    monkeypatch.setattr(nhmrc, "LANDING", ["nhmrc"])
    monkeypatch.setattr(mrff, "LANDING", [])
    monkeypatch.setattr(crc, "PROGRAMS", {})
    monkeypatch.setattr(education, "RBG_LANDING", ["rbg"])
    monkeypatch.setattr(education, "HERDC_LANDING", ["herdc"])
    return tmp_path


def test_helpers():
    assert for_parts("0601 - Biochemistry") == ("0601", "06")
    assert for_parts("310101") == ("310101", "31")
    assert field_group("31") == "Natural sciences"
    assert field_group("16") == "Humanities & social sciences"
    assert arc_is_discovery("DE190100001", None)
    assert not arc_is_discovery("LP190100001", "Linkage Projects")
    assert to_amount("$1,200.50") == 1200.5


def test_build(offline):
    db = run.build(offline / "build")
    c = sqlite3.connect(db)
    grants = {r[0]: r for r in c.execute(
        "SELECT id, state, amount_aud, basic_science, field_group FROM grants")}
    assert grants["ARC:DP200100001"][1:] == ("WA", 450000.0, 1, "Natural sciences")
    assert grants["ARC:LP210200002"][1:] == ("NSW", 300000.0, 0, "Engineering & IT")
    assert grants["NHMRC:2001234"][1:] == ("WA", 1234567.0, 1, "Health & medical")
    assert grants["NHMRC:2001235"][3] == 0
    assert len([g for g in grants if g.startswith("NHMRC")]) == 2  # grand total dropped
    org = c.execute("SELECT name FROM organisations o JOIN grants g ON g.org_id=o.id "
                    "WHERE g.id='NHMRC:2001234'").fetchone()[0]
    assert org == "Harry Perkins Institute of Medical Research"
    assert c.execute("SELECT amount_aud FROM block_grants b JOIN organisations o "
                     "ON o.id=b.org_id WHERE o.name='Curtin University' AND year=2024 "
                     "AND program='RTP'").fetchone()[0] == 30000000
    assert c.execute("SELECT count(*) FROM research_income").fetchone()[0] == 4
    status = dict(c.execute("SELECT name, status FROM sources"))
    assert status["ARC"] == "ok" and status["NHMRC"] == "ok"


def test_carry_over(offline, monkeypatch):
    prev = run.build(offline / "prev")
    from etl.sources import nhmrc

    def boom(**_):
        raise RuntimeError("site down")
    monkeypatch.setattr(nhmrc, "load", boom)
    db = run.build(offline / "next", previous=prev)
    c = sqlite3.connect(db)
    assert dict(c.execute("SELECT name, status FROM sources"))["NHMRC"] == "cached"
    assert c.execute("SELECT count(*) FROM grants WHERE source='NHMRC'").fetchone()[0] == 2
    assert c.execute("SELECT basic_science FROM grants WHERE id='NHMRC:2001234'").fetchone()[0] == 1


def test_publish(offline):
    db = run.build(offline / "build")
    run.publish(db, offline / "site")
    c = sqlite3.connect(offline / "site" / "funding.sqlite")
    assert c.execute("SELECT count(*) FROM grants WHERE summary IS NOT NULL").fetchone()[0] == 0
    meta = json.loads((offline / "site" / "meta.json").read_text())
    assert {s["name"] for s in meta["sources"]} >= {"ARC", "NHMRC"}


def test_crc_tables(monkeypatch):
    from etl.sources import crc
    page = """<h2>CRC Projects Round 15 outcomes (announced February 2024)</h2>
    <table><tr><th>Lead participant</th><th>Project title</th><th>State</th><th>Grant amount (GST exclusive)</th></tr>
    <tr><td>Curtin University</td><td>Green steel</td><td>WA</td><td>$2,950,000</td></tr>
    <tr><td>Acme Pty Ltd</td><td>Robots</td><td>VIC</td><td>$1,000,000</td></tr></table>"""
    monkeypatch.setattr(crc, "PROGRAMS", {"CRC-P": "https://x/crcp"})
    monkeypatch.setattr(crc, "find_links", lambda url, pat: [])
    monkeypatch.setattr(crc, "fetch", lambda url, **_: page)
    rows = crc.load()["grants"]
    assert [(r["org_raw"], r["amount_aud"], r["round_year"], r["scheme"]) for r in rows] == [
        ("Curtin University", 2950000.0, 2024, "CRC-P Round 15"),
        ("Acme Pty Ltd", 1000000.0, 2024, "CRC-P Round 15")]


def test_archive_fallback(monkeypatch, tmp_path):
    import requests
    calls = []

    def fake_get(url, retries):
        calls.append(url)
        if "web.archive.org" not in url:
            raise requests.Timeout("stalled")
        return b"archived"
    monkeypatch.setattr(harvest, "_get", fake_get)
    monkeypatch.setattr(harvest, "CACHE", tmp_path)
    monkeypatch.setattr(harvest, "DEAD_HOSTS", set())
    assert harvest.fetch("https://slow.gov.au/a", use_cache=False) == "archived"
    assert harvest.fetch("https://slow.gov.au/b", use_cache=False) == "archived"
    # second URL on the same host goes straight to the archive
    assert [c for c in calls if "slow.gov.au/b" in c and "archive" not in c] == []


def test_crcp_partner_table(monkeypatch):
    from etl.sources import crc
    page = """<h2>Successful CRC Projects Round 12</h2><table>
    <tr><th>Title</th><th>Partners*</th><th>Description</th><th>Start/End Date</th><th>Total Grant amount</th><th>Total Project Value</th></tr>
    <tr><td>Cannabinoids</td><td><p>Cannapacific Pty Ltd</p><p>Curtin University</p></td><td>x</td>
        <td>15 Jan 2022 - 15 Dec 2024</td><td>$3,000,000</td><td>$8,014,982</td></tr></table>"""
    monkeypatch.setattr(crc, "PROGRAMS", {"CRC-P": "https://x/crcp"})
    monkeypatch.setattr(crc, "find_links", lambda url, pat: [])
    monkeypatch.setattr(crc, "fetch", lambda url, **_: page)
    r = crc.load()["grants"][0]
    assert (r["org_raw"], r["amount_aud"], r["round_year"], r["scheme"]) == (
        "Cannapacific Pty Ltd", 3000000.0, 2022, "CRC-P Round 12")


def test_rbg_long_format():
    from etl.sources import education
    content = xlsx({"Table 2": pd.DataFrame([
        ["Table 2: Research block grant"],
        ["HEP Code", "HEP Name", "Year", "State", "Cohort", "Program", "Amount"],
        [3040, "Curtin University", 2010, "WA", "ATN", "JRE", 5000000]])})
    df = next(harvest.read_tables(content, education.RBG_SYN, ["org"], "x.xlsx"))[1]
    assert list(education._long(df, [], None)) == [("Curtin University", 2010, "JRE", 5000000.0)]
