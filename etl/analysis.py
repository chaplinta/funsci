"""Where is basic science funding heading? WA vs the rest of Australia.

Run after the build. Writes site/data/analysis.json (series + findings for the Trends tab)
and a markdown report (workflow step summary).

Basic science here = ARC Discovery program + NHMRC Basic Science, excluding humanities and
social sciences. Amounts are total grant values in the commencement/application year.
"""
import json
import math
import sqlite3
import statistics
from collections import defaultdict

# Fallback if the ABS API was unreachable: June 2024 ERP.
POP_2024 = {"NSW": 8469595, "VIC": 6959205, "QLD": 5560452, "WA": 2951602, "SA": 1878029,
            "TAS": 575959, "ACT": 472763, "NT": 254300}
STATES = list(POP_2024)
REGIONS = {"WA": ["WA"], "EXWA": [s for s in STATES if s != "WA"]}
LABEL = {"WA": "WA", "EXWA": "rest of Australia"}
BASIC = ("g.basic_science = 1 AND COALESCE(g.field_group, '') <> 'Humanities & social sciences' "
         "AND g.source IN ('ARC', 'NHMRC')")


def ols(xs, ys):
    """Slope and intercept of y on x."""
    n = len(xs)
    if n < 3:
        return None, None
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if not sxx:
        return None, None
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    return b, my - b * mx


def growth(years, values):
    """Compound annual % change from a log-linear fit; None if any value <= 0 or too few points."""
    pts = [(y, v) for y, v in zip(years, values) if v and v > 0]
    if len(pts) < 3:
        return None
    b, _ = ols([p[0] for p in pts], [math.log(p[1]) for p in pts])
    return None if b is None else math.exp(b) - 1


def last_complete_year(counts):
    """Latest year whose grant count is at least 60% of the median of the three before it.

    Recent rounds are often not yet announced (or only partly), which would read as a collapse.
    """
    years = sorted(counts)
    for y in reversed(years):
        prior = [counts[p] for p in years if y - 3 <= p < y]
        if len(prior) < 3 or counts[y] >= 0.6 * statistics.median(prior):
            return y
    return years[-1] if years else None


class Data:
    def __init__(self, conn):
        self.c = conn
        self.pop = defaultdict(dict)
        for st, yr, n in conn.execute("SELECT state, year, persons FROM population"):
            self.pop[st][yr] = n
        self.cpi = dict(conn.execute("SELECT year, idx FROM cpi"))
        self.has_pop = bool(self.pop)
        self.has_cpi = bool(self.cpi)
        self.base_year = max(self.cpi) if self.cpi else None

    def persons(self, region, year):
        total = 0
        for st in REGIONS[region]:
            s = self.pop.get(st)
            if not s:
                total += POP_2024[st]
            else:
                near = min(s, key=lambda y: abs(y - year))
                total += s[near]
        return total

    def real(self, amount, year):
        """Amount in base-year dollars."""
        if not self.has_cpi or amount is None:
            return amount
        near = min(self.cpi, key=lambda y: abs(y - year))
        return amount * self.cpi[self.base_year] / self.cpi[near]

    def q(self, sql, params=()):
        return self.c.execute(sql, params).fetchall()


def region_sql(region):
    return "g.state IN (%s)" % ",".join("'%s'" % s for s in REGIONS[region])


def build(conn):
    d = Data(conn)
    # completeness per funder
    complete, starts = {}, {}
    for src in ("ARC", "NHMRC"):
        counts = dict(d.q(f"SELECT round_year, COUNT(*) FROM grants g WHERE source=? AND {BASIC} "
                          "AND round_year IS NOT NULL GROUP BY 1", (src,)))
        complete[src] = last_complete_year(counts)
        # first year with a full round (NHMRC files only go back so far); before that a funder is missing
        full = [y for y, n in sorted(counts.items()) if n >= 0.5 * statistics.median(counts.values())]
        starts[src] = full[0] if full else None
    last = min(v for v in complete.values() if v) if any(complete.values()) else None
    first = max([v for v in starts.values() if v] or [2001])
    years = list(range(first, (last or first) + 1))

    series = {}
    for r in REGIONS:
        rows = d.q(f"""SELECT round_year, source, SUM(amount_aud), COUNT(*), AVG(team_size)
                       FROM grants g WHERE {BASIC} AND {region_sql(r)} AND round_year BETWEEN ? AND ?
                       GROUP BY 1, 2""", (first, last))
        by = defaultdict(lambda: {"amount": 0.0, "n": 0, "ARC": 0.0, "NHMRC": 0.0, "team": None})
        for yr, src, amt, n, team in rows:
            e = by[yr]
            e["amount"] += amt or 0
            e["n"] += n
            e[src] += amt or 0
            if src == "ARC":
                e["team"] = team
        out = []
        for y in years:
            e = by[y]
            real = d.real(e["amount"], y)
            pop = d.persons(r, y)
            out.append({
                "year": y, "nominal": e["amount"], "real": real, "grants": e["n"],
                "per_capita_real": real / pop if pop else None,
                "mean_grant_real": real / e["n"] if e["n"] else None,
                "arc_real": d.real(e["ARC"], y), "nhmrc_real": d.real(e["NHMRC"], y),
                "arc_team": e["team"],
            })
        series[r] = out

    # per-investigator value (ARC, where teams are listed)
    per_inv = {}
    for r in REGIONS:
        rows = dict((y, v) for y, v in d.q(f"""SELECT round_year, AVG(amount_aud / team_size) FROM grants g
                    WHERE {BASIC} AND source='ARC' AND team_size > 0 AND {region_sql(r)}
                    AND round_year BETWEEN ? AND ? GROUP BY 1""", (first, last)))
        per_inv[r] = [{"year": y, "per_investigator_real": d.real(rows.get(y), y)} for y in years]

    share = []
    for wa, ex in zip(series["WA"], series["EXWA"]):
        tot = (wa["real"] or 0) + (ex["real"] or 0)
        share.append({"year": wa["year"], "wa_share": (wa["real"] or 0) / tot if tot else None})

    def window(n):
        return [y for y in years if y > (last or 0) - n]

    trends = {}
    for r in REGIONS:
        s = {e["year"]: e for e in series[r]}
        t = {}
        for n in (5, 10):
            ys = window(n)
            t[f"per_capita_{n}y"] = growth(ys, [s[y]["per_capita_real"] for y in ys])
            t[f"grants_{n}y"] = growth(ys, [s[y]["grants"] for y in ys])
            t[f"mean_grant_{n}y"] = growth(ys, [s[y]["mean_grant_real"] for y in ys])
            t[f"arc_{n}y"] = growth(ys, [s[y]["arc_real"] for y in ys])
            t[f"nhmrc_{n}y"] = growth(ys, [s[y]["nhmrc_real"] for y in ys])
        ys = window(10)
        t["per_capita_last3_avg"] = statistics.mean([s[y]["per_capita_real"] or 0 for y in ys[-3:]]) if ys else None
        t["per_capita_first3_avg"] = statistics.mean([s[y]["per_capita_real"] or 0 for y in ys[:3]]) if ys else None
        pi = {e["year"]: e["per_investigator_real"] for e in per_inv[r]}
        t["per_investigator_10y"] = growth(ys, [pi[y] for y in ys])
        t["team_10y"] = growth(ys, [s[y]["arc_team"] for y in ys])
        trends[r] = t
    sh = {e["year"]: e["wa_share"] for e in share}
    ys = window(10)
    b, _ = ols(ys, [sh[y] or 0 for y in ys]) if ys else (None, None)
    trends["wa_share_pp_per_year_10y"] = b * 100 if b is not None else None
    trends["wa_share_last3"] = statistics.mean([sh[y] or 0 for y in ys[-3:]]) if ys else None
    trends["wa_share_first3"] = statistics.mean([sh[y] or 0 for y in ys[:3]]) if ys else None

    # topics: real per-capita, first vs second half of the 10-year window
    topics = []
    if ys:
        half = len(ys) // 2
        early, late = ys[:half], ys[half:]
        for (topic,) in d.q("SELECT DISTINCT topic FROM grant_topics"):
            row = {"topic": topic}
            for r in REGIONS:
                vals = dict((y, a) for y, a in d.q(f"""SELECT g.round_year, SUM(g.amount_aud) FROM grants g
                            JOIN grant_topics t ON t.grant_id = g.id AND t.topic = ?
                            WHERE {BASIC} AND {region_sql(r)} AND g.round_year BETWEEN ? AND ?
                            GROUP BY 1""", (topic, ys[0], ys[-1])))
                pc = {y: d.real(vals.get(y, 0), y) / d.persons(r, y) for y in ys}
                e, l_ = statistics.mean(pc[y] for y in early), statistics.mean(pc[y] for y in late)
                row[f"{r}_early"], row[f"{r}_late"] = e, l_
                row[f"{r}_change"] = (l_ / e - 1) if e else None
            topics.append(row)
        topics.sort(key=lambda x: -(x.get("WA_late") or 0))

    # WA institutions: real totals, last 5 vs previous 5 complete years
    insts = []
    if last:
        for name, a, b2 in d.q(f"""SELECT o.name,
                SUM(CASE WHEN g.round_year BETWEEN ? AND ? THEN g.amount_aud END),
                SUM(CASE WHEN g.round_year BETWEEN ? AND ? THEN g.amount_aud END)
                FROM grants g JOIN organisations o ON o.id = g.org_id
                WHERE {BASIC} AND g.state = 'WA' GROUP BY 1""", (last - 9, last - 5, last - 4, last)):
            if (a or 0) + (b2 or 0) > 2e6:
                insts.append({"org": name, "prev5": a or 0, "last5": b2 or 0,
                              "change": ((b2 or 0) / a - 1) if a else None})
        insts.sort(key=lambda x: -x["last5"])

    meta = {"last_complete_year": last, "complete_by_funder": complete, "first_year_by_funder": starts,
            "first_year": first, "window": [ys[0], ys[-1]] if ys else None,
            "real_dollars": d.has_cpi, "base_year": d.base_year, "population_by_year": d.has_pop}
    result = {"meta": meta, "series": series, "per_investigator": per_inv, "share": share,
              "trends": trends, "topics": topics, "institutions": insts}
    result["findings"] = findings(result)
    return result


def pct(x, signed=True):
    if x is None:
        return "n/a"
    return f"{x * 100:+.1f}%" if signed else f"{x * 100:.1f}%"


def money(x):
    return "n/a" if x is None else f"${x:,.0f}"


def findings(r):
    m, t = r["meta"], r["trends"]
    if not m["window"]:
        return ["Not enough data for trends."]
    y0, y1 = m["window"]
    dollars = f"{m['base_year']} dollars" if m["real_dollars"] else "nominal dollars (CPI unavailable)"
    wa, ex = t["WA"], t["EXWA"]
    out = [
        f"Window: {y0}–{y1}. Series start in {m['first_year']}, the first year both ARC and NHMRC data are complete; "
        f"Latest complete year {y1}; later years are left out until their rounds are fully announced. "
        f"Amounts in {dollars}, per resident{' using each year’s population' if m['population_by_year'] else ' using 2024 population'}.",
        f"Basic science funding per resident changed {pct(wa['per_capita_10y'])} a year in WA over 10 years, "
        f"against {pct(ex['per_capita_10y'])} a year in the rest of Australia "
        f"(5-year: WA {pct(wa['per_capita_5y'])}, rest {pct(ex['per_capita_5y'])}).",
        f"Per resident, WA averaged {money(wa['per_capita_last3_avg'])} a year over the last three years "
        f"against {money(ex['per_capita_last3_avg'])} elsewhere "
        f"(first three years of the window: WA {money(wa['per_capita_first3_avg'])}, rest {money(ex['per_capita_first3_avg'])}).",
        f"WA's share of national basic science funding went from {pct(t['wa_share_first3'], False)} to "
        f"{pct(t['wa_share_last3'], False)} (three-year averages), a trend of "
        f"{t['wa_share_pp_per_year_10y']:+.2f} percentage points a year. WA has about 10.9% of the population."
        if t["wa_share_pp_per_year_10y"] is not None else "WA share trend unavailable.",
        f"By funder over 10 years, ARC Discovery funding changed {pct(wa['arc_10y'])} a year in WA and {pct(ex['arc_10y'])} elsewhere; "
        f"NHMRC Basic Science {pct(wa['nhmrc_10y'])} in WA and {pct(ex['nhmrc_10y'])} elsewhere.",
        f"Grant numbers changed {pct(wa['grants_10y'])} a year in WA ({pct(ex['grants_10y'])} elsewhere) while the average "
        f"grant changed {pct(wa['mean_grant_10y'])} ({pct(ex['mean_grant_10y'])}): "
        + ("fewer, larger grants." if (wa["grants_10y"] or 0) < 0 < (wa["mean_grant_10y"] or 0) else
           "more grants." if (wa["grants_10y"] or 0) > 0 else "smaller grants." if (wa["mean_grant_10y"] or 0) < 0 else ""),
        f"ARC team size changed {pct(wa['team_10y'])} a year in WA; value per named investigator changed "
        f"{pct(wa['per_investigator_10y'])} a year in WA and {pct(ex['per_investigator_10y'])} elsewhere.",
    ]
    tops = [x for x in r["topics"] if x.get("WA_change") is not None and (x.get("WA_late") or 0) > 0.5]
    if tops:
        fmt = lambda xs: ", ".join(f"{x['topic']} ({pct(x['WA_change'])}; rest {pct(x['EXWA_change'])})" for x in xs)
        up = sorted([x for x in tops if x["WA_change"] > 0], key=lambda x: -x["WA_change"])[:3]
        down = sorted([x for x in tops if x["WA_change"] < 0], key=lambda x: x["WA_change"])[:3]
        parts = ([f"growing {fmt(up)}"] if up else []) + ([f"shrinking {fmt(down)}"] if down else [])
        out.append("Biology topics in WA, second half of the window against the first, per resident: "
                   + "; ".join(parts) + ".")
    gaps = [x for x in r["topics"] if x.get("EXWA_late") and x.get("WA_late") is not None]
    if gaps:
        worst = min(gaps, key=lambda x: x["WA_late"] / x["EXWA_late"] if x["EXWA_late"] else 9)
        best = max(gaps, key=lambda x: x["WA_late"] / x["EXWA_late"] if x["EXWA_late"] else 0)
        out.append(f"Relative to the rest of Australia per resident, WA is strongest in {best['topic']} "
                   f"({best['WA_late'] / best['EXWA_late']:.2f}×) and weakest in {worst['topic']} "
                   f"({worst['WA_late'] / worst['EXWA_late']:.2f}×), recent half of the window.")
    inst = [i for i in r["institutions"] if i["change"] is not None][:6]
    if inst:
        out.append("WA institutions, last five complete years against the five before: "
                   + "; ".join(f"{i['org']} {pct(i['change'])}" for i in inst) + " (nominal).")
    return out


def markdown(r):
    lines = ["## Basic science funding trends: WA vs rest of Australia", ""]
    lines += [f"- {f}" for f in r["findings"]]
    lines += ["", "| Year | WA per resident | Rest per resident | WA share | WA grants | Rest grants |", "|---|---|---|---|---|---|"]
    for wa, ex, sh in zip(r["series"]["WA"], r["series"]["EXWA"], r["share"]):
        lines.append(f"| {wa['year']} | {money(wa['per_capita_real'])} | {money(ex['per_capita_real'])} | "
                     f"{pct(sh['wa_share'], False)} | {wa['grants']} | {ex['grants']} |")
    lines += ["", "| Topic | WA early | WA late | WA change | Rest early | Rest late | Rest change |", "|---|---|---|---|---|---|---|"]
    for x in r["topics"]:
        lines.append(f"| {x['topic']} | {x['WA_early']:.2f} | {x['WA_late']:.2f} | {pct(x['WA_change'])} | "
                     f"{x['EXWA_early']:.2f} | {x['EXWA_late']:.2f} | {pct(x['EXWA_change'])} |")
    lines += ["", "| WA institution | Prev 5y | Last 5y | Change |", "|---|---|---|---|"]
    for i in r["institutions"][:15]:
        lines.append(f"| {i['org']} | {money(i['prev5'])} | {money(i['last5'])} | {pct(i['change'])} |")
    lines += ["", f"Meta: {json.dumps(r['meta'])}"]
    return "\n".join(lines)


def run(db, site_data, report_path=None):
    conn = sqlite3.connect(db)
    r = build(conn)
    conn.close()
    (site_data / "analysis.json").write_text(json.dumps(r, indent=1))
    md = markdown(r)
    if report_path:
        report_path.write_text(md)
    return r, md
