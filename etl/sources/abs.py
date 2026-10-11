"""ABS estimated resident population by state and CPI, for per-capita and real-dollar figures.

Uses the ABS Data API (SDMX, CSV). Several URL forms are tried because the API has moved
between hosts; the first that parses wins.
"""
import io
import logging

import pandas as pd

from etl.harvest import fetch

log = logging.getLogger("abs")
NAME = "ABS"
CSV = {"Accept": "application/vnd.sdmx.data+csv;labels=id;version=1.0.0"}
STATE_CODES = {"1": "NSW", "2": "VIC", "3": "QLD", "4": "SA", "5": "WA", "6": "TAS", "7": "NT", "8": "ACT"}

CPI_URLS = [
    "https://data.api.abs.gov.au/rest/data/ABS,CPI,1.1.0/1.10001.10.50.Q?startPeriod=1995",
    "https://data.api.abs.gov.au/rest/data/ABS,CPI/1.10001.10.50.Q?startPeriod=1995",
    "https://api.data.abs.gov.au/data/ABS,CPI,1.0.0/1.10001.10.50.Q?startPeriod=1995&format=csv",
]
ERP_URLS = [
    "https://data.api.abs.gov.au/rest/data/ABS,ERP_Q,1.0.0/1.3.TOT.1+2+3+4+5+6+7+8.Q?startPeriod=1995",
    "https://data.api.abs.gov.au/rest/data/ABS,ERP_Q/1.3.TOT.1+2+3+4+5+6+7+8.Q?startPeriod=1995",
    "https://api.data.abs.gov.au/data/ABS,ERP_Q,1.0.0/1.3.TOT.1+2+3+4+5+6+7+8.Q?startPeriod=1995&format=csv",
]


def _frame(urls, label):
    for url in urls:
        try:
            text = fetch(url, headers=CSV, use_cache=False, archive=False, retries=2)
            df = pd.read_csv(io.StringIO(text), dtype=str)
            if {"TIME_PERIOD", "OBS_VALUE"} <= set(df.columns):
                log.info("%s: %d rows from %s; columns %s", label, len(df), url, list(df.columns))
                return df, url
            log.info("%s: unexpected CSV from %s: %s", label, url, text[:300])
        except Exception as e:  # noqa: BLE001
            log.warning("%s failed %s: %s", label, url, str(e)[:200])
    return None, None


def parse_cpi(df):
    """Annual average of the quarterly All groups index."""
    d = df[["TIME_PERIOD", "OBS_VALUE"]].dropna()
    d = d.assign(year=d.TIME_PERIOD.str[:4].astype(int), v=pd.to_numeric(d.OBS_VALUE, errors="coerce"))
    g = d.groupby("year").v.agg(["mean", "count"])
    return [(int(y), float(r["mean"])) for y, r in g.iterrows() if r["count"] == 4 or y == g.index.max()]


def parse_erp(df):
    """June-quarter persons by state. Finds the region column by its values."""
    for col, keep in (("SEX", "3"), ("SEX_ABS", "3"), ("AGE", "TOT")):
        if col in df.columns and keep in set(df[col]):
            df = df[df[col] == keep]
    allowed = set(STATE_CODES) | {"AUS", "0", "9"}
    cands = [c for c in df.columns if c not in ("TIME_PERIOD", "OBS_VALUE")
             and set(df[c].dropna()) and set(df[c].dropna()) <= allowed]
    # the region column carries several state codes; constant dimensions like MEASURE=1 don't
    region = max(cands, key=lambda c: (len(set(df[c]) & set(STATE_CODES)), "REGION" in c or "STATE" in c),
                 default=None)
    if region is None or len(set(df[region]) & set(STATE_CODES)) < 2:
        raise ValueError(f"no state column in {list(df.columns)}")
    d = df[df[region].isin(STATE_CODES) & df.TIME_PERIOD.str.endswith(("Q2", "-06"))]
    d = d.assign(v=pd.to_numeric(d.OBS_VALUE, errors="coerce")).dropna(subset=["v"])
    return [(STATE_CODES[r[region]], int(r["TIME_PERIOD"][:4]), float(r["v"])) for r in d.to_dict("records")]


def load(samples_dir=None):
    out, urls = {}, []
    cpi, url = _frame(CPI_URLS, "CPI")
    if cpi is not None:
        out["cpi"] = parse_cpi(cpi)
        urls.append(url)
    erp, url = _frame(ERP_URLS, "ERP")
    if erp is not None:
        out["population"] = parse_erp(erp)
        urls.append(url)
    log.info("ABS: %d CPI years, %d population rows", len(out.get("cpi", [])), len(out.get("population", [])))
    if not out:
        raise RuntimeError("ABS API unreachable; site falls back to 2024 population and nominal dollars")
    out["url"] = ", ".join(urls)
    return out
