# Australian Research Funding Explorer

Static site for analysing Australian research funding outcomes, with a focus on basic science in Western Australia.

Live site: https://chaplinta.github.io/funsci/

## What's in it

| Source | Module | Method |
|---|---|---|
| ARC National Competitive Grants Program | `etl/sources/arc.py` | ARC Data Portal JSON API |
| NHMRC outcomes | `etl/sources/nhmrc.py` | Spreadsheets linked from nhmrc.gov.au |
| MRFF grant recipients | `etl/sources/mrff.py` | Spreadsheet from health.gov.au |
| Research Block Grants (RTP, RSP) and HERDC income | `etl/sources/education.py` | Spreadsheets from education.gov.au |
| Philanthropy, WA Government programs | `data/manual/*.csv` | Hand-curated, each row has a source URL |

Everything lands in one SQLite database (`etl/schema.sql`). The site loads it in the browser with sql.js and draws charts with Observable Plot. No server.

## How it runs

`.github/workflows/build.yml` runs weekly and on every push: tests, ETL, then deploys `site/` to GitHub Pages (default branch only). If a source fails, its rows are carried over from the currently published database and flagged "cached" on the Data & methods tab. The run summary lists each source's status; `etl-diagnostics` artifact has the log and sample API payloads.

Spreadsheet columns are matched by synonym (`etl/sources/sheets.py`, `GRANT_SYNONYMS`) because agency layouts change year to year. If a source reports zero rows, check the log and add the new header names there, or add direct file URLs to the module's `EXTRA` list.

## Local

```sh
pip install -r requirements.txt
python -m pytest -q tests
python -m etl.run            # writes build/funding.sqlite and site/data/
cd site && python -m http.server
```

Add organisation aliases in `data/manual/organisations.csv` when names fail to merge.

## Definitions

- Basic science: ARC Discovery program schemes (DP, DE, FT, FL, IN) and NHMRC grants in the Basic Science broad research area. The WA view also excludes humanities and social sciences.
- Amounts are total awarded value counted in the commencement/application year, nominal AUD.
- State is the administering organisation's state.
