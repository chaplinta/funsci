/* Australian Research Funding Explorer: loads the SQLite DB in the browser and draws views. */
"use strict";

const GRANT_SOURCES = ["ARC", "NHMRC", "MRFF", "CRC"];
const STATES = ["WA", "NSW", "VIC", "QLD", "SA", "TAS", "ACT", "NT"];
// ABS estimated resident population, June 2024.
const POP = { NSW: 8469595, VIC: 6959205, QLD: 5560452, WA: 2951602, SA: 1878029,
  TAS: 575959, ACT: 472763, NT: 254300 };
const POP_TOTAL = Object.values(POP).reduce((a, b) => a + b, 0);
const FOR_NAMES = {
  "01": "Mathematical Sciences", "02": "Physical Sciences", "03": "Chemical Sciences",
  "04": "Earth Sciences", "05": "Environmental Sciences", "06": "Biological Sciences",
  "07": "Agricultural & Veterinary", "08": "Information & Computing", "09": "Engineering",
  "10": "Technology", "11": "Medical & Health Sciences", "12": "Built Environment",
  "13": "Education", "14": "Economics", "15": "Commerce & Management", "16": "Studies in Human Society",
  "17": "Psychology & Cognitive", "18": "Law", "19": "Creative Arts", "20": "Language & Culture",
  "21": "History & Archaeology", "22": "Philosophy & Religion",
  "30": "Agricultural, Veterinary & Food", "31": "Biological Sciences", "32": "Biomedical & Clinical",
  "33": "Built Environment", "34": "Chemical Sciences", "35": "Commerce & Management",
  "36": "Creative Arts", "37": "Earth Sciences", "38": "Economics", "39": "Education",
  "40": "Engineering", "41": "Environmental Sciences", "42": "Health Sciences", "43": "History",
  "44": "Human Society", "45": "Indigenous Studies", "46": "Information & Computing",
  "47": "Language & Culture", "48": "Law & Legal Studies", "49": "Mathematical Sciences",
  "50": "Philosophy & Religion", "51": "Physical Sciences", "52": "Psychology",
};

const TOPICS = ["Neuroscience", "Evolution", "Ecology", "Genetics & genomics", "Cell & molecular biology",
  "Microbiology", "Plant biology", "Zoology & animal biology", "Physiology", "Immunology",
  "Bioinformatics & computational biology", "Structural biology & biophysics"];

let db;
let personKey = null;  // researcher shown on the Researchers tab
const $ = (s) => document.querySelector(s);
const fmtM = (v) => v == null ? "–" : `$${d3.format(",.1f")(v / 1e6)}m`;
const fmtB = (v) => v >= 1e9 ? `$${d3.format(",.2f")(v / 1e9)}b` : fmtM(v);
const fmtInt = d3.format(",");
const fmtPct = d3.format(".1%");
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function q(sql, params = []) {
  const st = db.prepare(sql);
  st.bind(params);
  const out = [];
  while (st.step()) out.push(st.getAsObject());
  st.free();
  return out;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ---------- filters ---------- */
function filters() {
  return {
    from: +$("#f-from").value, to: +$("#f-to").value,
    sources: [...document.querySelectorAll("#f-sources input:checked")].map((i) => i.value),
    field: $("#f-field").value, basic: $("#f-basic").checked,
    topic: $("#f-topic").value, kw: $("#f-kw").checked, credit: $("#f-credit").value,
  };
}

// Grant g carries topic (FoR-coded only unless keyword matches are on).
function topicClause(topic, kw = filters().kw) {
  return [`EXISTS (SELECT 1 FROM grant_topics t WHERE t.grant_id = g.id AND t.topic = ?${kw ? "" : " AND t.method = 'for'"})`, topic];
}
const methodSQL = () => (filters().kw ? "" : " AND t.method = 'for'");

// WHERE fragment over grants aliased g. opts.basic / opts.topic override the filter bar
// (opts.topic = null ignores the topic filter).
function where(extra = [], opts = {}) {
  const f = filters();
  const parts = ["g.round_year BETWEEN ? AND ?"], p = [f.from, f.to];
  parts.push(`g.source IN (${f.sources.map(() => "?").join(",") || "''"})`); p.push(...f.sources);
  if (f.field) { parts.push("g.field_group = ?"); p.push(f.field); }
  if (opts.basic ?? f.basic) parts.push("g.basic_science = 1");
  const topic = "topic" in opts ? opts.topic : f.topic;
  if (topic) { const [sql, v] = topicClause(topic, f.kw); parts.push(sql); p.push(v); }
  for (const [sql, ...vals] of extra) { parts.push(sql); p.push(...vals); }
  return [parts.join(" AND "), p];
}

/* ---------- rendering helpers ---------- */
function colorScale() {
  return { domain: GRANT_SOURCES, range: ["--s1", "--s2", "--s3", "--s4"].map(css), legend: true };
}

function plotInto(sel, opts) {
  const el = $(sel);
  el.replaceChildren();
  const width = Math.max(320, el.clientWidth || 800);
  const chart = Plot.plot({
    width, marginLeft: 50, style: { background: "transparent", color: css("--ink"), fontSize: "12px" },
    ...opts,
  });
  el.append(chart);
}

const narrow = () => window.innerWidth < 640;
// Continuous year axis with whole-year ticks only.
function yearLineX(rows) {
  const ys = [...new Set(rows.map((d) => d.year))].sort((a, b) => a - b);
  const k = Math.ceil(ys.length / (narrow() ? 5 : 16));
  return { label: null, tickFormat: "d", ticks: ys.filter((_, i) => i % k === 0) };
}
// Band year axis that thins its labels on narrow screens.
function yearX(extra = {}) {
  const k = narrow() ? 4 : 1;
  return { label: null, type: "band", tickFormat: (d) => (d % k ? "" : String(d)), ...extra };
}
// Left margin and label truncation for long category names.
function catY(domain, wide) {
  const max = narrow() ? 22 : 60;
  return {
    marginLeft: narrow() ? 150 : wide,
    y: { label: null, domain, tickFormat: (d) => (d.length > max ? d.slice(0, max - 1) + "…" : d) },
  };
}

function empty(sel, msg = "No data for this selection.") {
  $(sel).innerHTML = `<p class="note">${msg}</p>`;
}

// Sort value for a cell: explicit c.sv, the raw field, or a number parsed from the rendered text
// ("$1.2m", "45.3%", "1,234", "2.10×"); text otherwise.
function sortValue(c, r) {
  if (c.sv) return c.sv(r);
  if (c.key) return r[c.key];
  const t = String(c.f(r)).replace(/<[^>]*>/g, "").trim();
  const m = t.match(/^([+-]?)\$?([\d,]*\.?\d+)\s*(b|m|k|%|×)?/i);
  if (!m) return t.toLowerCase() || null;
  const mult = { b: 1e9, m: 1e6, k: 1e3 }[(m[3] || "").toLowerCase()] || 1;
  return (m[1] === "-" ? -1 : 1) * parseFloat(m[2].replace(/,/g, "")) * mult;
}

const tableState = new Map();  // selector -> {rows, cols, grantKey, sort: [colIndex, dir]}

function table(sel, rows, cols, grantKey) {
  if (!rows.length) { tableState.delete(sel); return empty(sel); }
  const prev = tableState.get(sel);
  // keep the user's sort when the table is re-rendered with new data
  const sort = prev && prev.cols.length === cols.length && prev.cols.every((c, i) => c.label === cols[i].label) ? prev.sort : null;
  tableState.set(sel, { rows, cols, grantKey, sort });
  drawTable(sel);
}

function drawTable(sel) {
  const { rows, cols, grantKey, sort } = tableState.get(sel);
  let data = rows;
  if (sort) {
    const [i, dir] = sort;
    data = [...rows].sort((a, b) => {
      const x = sortValue(cols[i], a), y = sortValue(cols[i], b);
      if (x == null || x === "") return 1;
      if (y == null || y === "") return -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }
  const head = cols.map((c, i) => {
    const on = sort && sort[0] === i;
    const aria = on ? (sort[1] > 0 ? "ascending" : "descending") : "none";
    return `<th class="${c.n ? "n" : ""} sortable" data-col="${i}" aria-sort="${aria}" tabindex="0">${esc(c.label)}` +
      `<span class="arrow">${on ? (sort[1] > 0 ? "▲" : "▼") : ""}</span></th>`;
  }).join("");
  const tr = (r) => grantKey && r[grantKey] ? `<tr class="grow-row" data-grant="${esc(r[grantKey])}" tabindex="0">` : "<tr>";
  const body = data.map((r) => tr(r) + cols.map((c) => {
    const v = c.f ? c.f(r) : esc(r[c.key]);
    return `<td class="${c.n ? "n" : ""}">${v}</td>`;
  }).join("") + "</tr>").join("");
  $(sel).innerHTML = `<table data-sel="${esc(sel)}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function onSortClick(e) {
  const th = e.target.closest("th.sortable");
  if (!th || (e.type === "keydown" && e.key !== "Enter" && e.key !== " ")) return;
  e.preventDefault();
  const sel = th.closest("table").dataset.sel, st = tableState.get(sel);
  if (!st) return;
  const i = +th.dataset.col;
  // numbers start largest-first, text A–Z; a second click reverses
  const firstDir = typeof sortValue(st.cols[i], st.rows.find((r) => sortValue(st.cols[i], r) != null) || st.rows[0]) === "number" ? -1 : 1;
  st.sort = st.sort && st.sort[0] === i ? [i, -st.sort[1]] : [i, firstDir];
  drawTable(sel);
}

function tiles(sel, items) {
  $(sel).innerHTML = items.map(([k, v, d]) =>
    `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>` +
    `<div class="d">${esc(d || "")}</div></div>`).join("");
}

function downloadCSV(name, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const line = (r) => cols.map((c) => {
    const v = r[c] ?? "";
    return /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v;
  }).join(",");
  const blob = new Blob([[cols.join(","), ...rows.map(line)].join("\n")], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

const orgList = (s) => {
  const xs = (s || "").split(",").filter(Boolean);
  return esc(xs.slice(0, 3).join("; ")) + (xs.length > 3 ? ` <span class="note">+${xs.length - 3} more</span>` : "");
};
// Search links for a person. These are searches, not verified profiles: names aren't unique.
function personLinks(name, org, domain) {
  if (!name) return "";
  const e = encodeURIComponent;
  const inst = domain ? [`https://www.google.com/search?q=${e(`"${name}" site:${domain}`)}`, "Institution"]
    : org ? [`https://www.google.com/search?q=${e(`"${name}" "${org}"`)}`, "Institution"] : null;
  const links = [
    inst,
    [`https://scholar.google.com/citations?view_op=search_authors&mauthors=${e(name)}`, "Google Scholar"],
    [`https://www.linkedin.com/search/results/people/?keywords=${e(org ? `${name} ${org}` : name)}`, "LinkedIn"],
    [`https://orcid.org/orcid-search/search?searchQuery=${e(name)}`, "ORCID"],
  ].filter(Boolean);
  return `<span class="plinks">${links.map(([u, t]) =>
    `<a href="${esc(u)}" target="_blank" rel="noopener" title="Search ${esc(t)} for ${esc(name)}">${esc(t)}</a>`).join("")}</span>`;
}
const who = (key, name) => key ? `<a class="who" data-key="${esc(key)}">${esc(name)}</a>` : esc(name);

// One row per (grant, person); role filter optional. Avoids double counting lead + CI rows.
const peopleSQL = (role) => `(SELECT grant_id, name_key, MAX(name) name, MIN(role) role, MAX(share_aud) share_aud FROM investigators
  ${role ? "WHERE role = 'lead'" : ""} GROUP BY grant_id, name_key)`;

function stackedYears(sel, rows, height = 280) {
  if (!rows.length) return empty(sel);
  plotInto(sel, {
    height, x: yearX(), y: { label: "A$m", grid: true }, color: colorScale(),
    marks: [Plot.barY(rows, { x: "year", y: "m", fill: "source", inset: 1, rx: 2, tip: { format: { x: (d) => String(d), m: ",.1f" } } }), Plot.ruleY([0])],
  });
}

function stackedOrgs(sel, rows, n = 15) {
  if (!rows.length) return empty(sel);
  const order = d3.groupSort(rows, (v) => -d3.sum(v, (d) => d.m), (d) => d.org).slice(0, n);
  plotInto(sel, {
    height: 40 + order.length * 26, ...catY(order, 260), x: { label: "A$m", grid: true }, color: colorScale(),
    marks: [Plot.barX(rows.filter((d) => order.includes(d.org)), { y: "org", x: "m", fill: "source", rx: 2, inset: 1,
      tip: { format: { m: ",.1f" } } }), Plot.ruleX([0])],
  });
}

/* ---------- regions, population, real dollars ---------- */
const REGION_STATES = { WA: ["WA"], EXWA: STATES.filter((s) => s !== "WA"), AUS: STATES };
const REGION_LABEL = { WA: "WA", EXWA: "Australia excl. WA", AUS: "Australia" };
const statesOf = (r) => REGION_STATES[r] || [r];
const regionName = (r) => REGION_LABEL[r] || r;
// [sql, ...params] restricting col to the region's states
const inRegion = (r, col = "g.state") => { const ss = statesOf(r); return [`${col} IN (${ss.map(() => "?").join(",")})`, ...ss]; };
let POPY = {};   // ABS population: state -> {year: persons}
let CPI = {};    // ABS CPI: year -> index
// Denominators for "per" figures: residents (ABS), or students, research students, academic FTE and
// universities summed over each state's universities (Department of Education statistics).
let DENOM = { student: {}, hdr: {}, staff: {}, uni: {} };   // kind -> state -> year -> value
const PER = {
  resident: { label: "per resident", noun: "population" },
  student: { label: "per student", noun: "students" },
  hdr: { label: "per research student", noun: "research students" },
  staff: { label: "per academic (FTE)", noun: "academic staff" },
  uni: { label: "per university", noun: "universities" },
};
const perKind = () => ($("#f-per") && $("#f-per").value) || "resident";
const perLabel = () => PER[perKind()].label;
const perNoun = () => PER[perKind()].noun;
function nearest(map, year) {
  const ys = Object.keys(map || {}).map(Number);
  if (!ys.length) return null;
  return map[ys.reduce((a, b) => (Math.abs(b - year) < Math.abs(a - year) ? b : a))];
}
function popAt(st, year, kind = perKind()) {
  if (kind !== "resident") return nearest(DENOM[kind][st], year || filters().to);
  const s = POPY[st];
  if (!s || !year) return POP[st];
  return nearest(s, year);
}
const popOf = (r, year) => d3.sum(statesOf(r), (st) => popAt(st, year)) || null;
// average denominator over the selected years, for "per" figures on multi-year totals
function popPeriod(r) { const f = filters(); return d3.mean(d3.range(f.from, f.to + 1), (y) => popOf(r, y)) || null; }
const popShare = (r) => (popPeriod(r) && popPeriod("AUS") ? popPeriod(r) / popPeriod("AUS") : null);
const per = (amount, denom) => (amount != null && denom ? amount / denom : null);
const fmtPer = (v, dp = 2) => (v == null ? "–" : d3.format(`$,.${dp}f`)(v));
const CPI_BASE = () => d3.max(Object.keys(CPI).map(Number));
function realFactor(year) {
  const ys = Object.keys(CPI).map(Number);
  if (!ys.length || !year) return 1;
  const near = ys.reduce((a, b) => (Math.abs(b - year) < Math.abs(a - year) ? b : a));
  return CPI[CPI_BASE()] / CPI[near];
}
const dollarsLabel = () => (Object.keys(CPI).length ? `${CPI_BASE()} dollars` : "nominal dollars");

// Per-resident lines, WA vs rest of Australia. rows: [{year, wa, ex}] totals in dollars.
function waVsRest(sel, rows, height = 260) {
  const data = rows.flatMap((r) => [
    { year: r.year, region: "WA", v: per((r.wa || 0) * realFactor(r.year), popOf("WA", r.year)) },
    { year: r.year, region: "Australia excl. WA", v: per((r.ex || 0) * realFactor(r.year), popOf("EXWA", r.year)) },
  ]).filter((d) => d.v != null);
  if (!rows.length) return empty(sel);
  plotInto(sel, {
    height, x: yearLineX(data), y: { label: `A$ ${perLabel()} (${dollarsLabel()})`, grid: true, zero: true },
    color: { domain: ["WA", "Australia excl. WA"], range: [css("--s1"), css("--s2")], legend: true },
    marks: [
      Plot.lineY(data, { x: "year", y: "v", stroke: "region", strokeWidth: 2 }),
      Plot.dot(data, { x: "year", y: "v", fill: "region", r: 2.5 }),
      Plot.tip(data, Plot.pointer({ x: "year", y: "v", channels: { region: "region" }, format: { x: (d) => String(d), y: ",.2f" } })),
    ],
  });
}
const exStates = () => REGION_STATES.EXWA.map((x) => `'${x}'`).join(",");
// SELECT fragment giving WA and ex-WA sums of an amount column
const waExSums = (col = "g.amount_aud", stateCol = "g.state") =>
  `SUM(CASE WHEN ${stateCol} = 'WA' THEN ${col} END) wa, SUM(CASE WHEN ${stateCol} IN (${exStates()}) THEN ${col} END) ex`;

// Researcher credit: split equally among named investigators, or full grant value
const creditAmt = () => (filters().credit === "full" ? "g.amount_aud" : "COALESCE(i.share_aud, g.amount_aud)");
const creditLabel = () => (filters().credit === "full" ? "full grant value" : "split among named investigators");

const yearsLabel = () => { const f = filters(); return `${f.from}–${f.to}`; };

/* ---------- views ---------- */
const views = {
  overview() {
    const [w, p] = where();
    const tot = q(`SELECT COUNT(*) n, SUM(amount_aud) s, SUM(CASE WHEN state='WA' THEN amount_aud END) wa
                   FROM grants g WHERE ${w}`, p)[0];
    tiles("#ov-tiles", [
      ["Grants", fmtInt(tot.n), yearsLabel()],
      ["Total awarded", fmtB(tot.s || 0), "selected funders"],
      ["Awarded to WA", fmtB(tot.wa || 0), "administering organisation in WA"],
      ["WA share", tot.s ? fmtPct(tot.wa / tot.s) : "–", `WA share of ${perNoun()} ${popShare("WA") == null ? "–" : fmtPct(popShare("WA"))}`],
    ]);

    const byYear = q(`SELECT round_year year, source, SUM(amount_aud)/1e6 m, COUNT(*) n
                      FROM grants g WHERE ${w} GROUP BY 1,2`, p);
    if (!byYear.length) empty("#ov-year");
    else plotInto("#ov-year", {
      height: 320, x: yearX(), y: { label: "A$m", grid: true },
      color: colorScale(),
      marks: [Plot.barY(byYear, { x: "year", y: "m", fill: "source", inset: 1, rx: 2, tip: { format: { x: (d) => String(d), m: ",.1f" } } }),
        Plot.ruleY([0])],
    });

    const byState = q(`SELECT state, SUM(amount_aud) s, COUNT(*) n FROM grants g
                       WHERE ${w} AND state IS NOT NULL GROUP BY 1`, p);
    const total = d3.sum(byState, (d) => d.s);
    const rows = STATES.map((st) => {
      const r = byState.find((d) => d.state === st) || { s: 0, n: 0 };
      return { state: st, share: total ? r.s / total : 0, pop: popShare(st), s: r.s, n: r.n,
        percap: per(r.s, popPeriod(st)) };
    });
    if (!total) { empty("#ov-state"); $("#ov-state-tbl").replaceChildren(); }
    else {
      plotInto("#ov-state", {
        height: 260, marginLeft: 44, x: { label: "share of national total", tickFormat: "%", grid: true },
        y: { label: null, domain: STATES },
        marks: [
          Plot.barX(rows, { y: "state", x: "share", fill: (d) => d.state === "WA" ? css("--accent") : css("--muted-mark"),
            rx: 2, tip: { format: { share: ".1%", fill: false } } }),
          Plot.tickX(rows, { y: "state", x: "pop", stroke: css("--ink"), strokeWidth: 2 }),
          Plot.ruleX([0]),
        ],
      });
      table("#ov-state-tbl", rows, [
        { key: "state", label: "State" },
        { label: "Grants", n: 1, f: (r) => fmtInt(r.n) },
        { label: "Amount", n: 1, f: (r) => fmtM(r.s) },
        { label: "Share of funding", n: 1, f: (r) => fmtPct(r.share) },
        { label: `Share of ${perNoun()}`, n: 1, f: (r) => (r.pop == null ? "–" : fmtPct(r.pop)) },
        { label: `A$ ${perLabel()}`, n: 1, f: (r) => (r.percap == null ? "–" : d3.format(",.0f")(r.percap)) },
      ]);
    }

    const share = q(`SELECT round_year year, source, SUM(CASE WHEN state='WA' THEN amount_aud ELSE 0 END)/SUM(amount_aud) share
                     FROM grants g WHERE ${w} GROUP BY 1,2 HAVING SUM(amount_aud) > 0`, p);
    if (!share.length) empty("#ov-washare");
    else plotInto("#ov-washare", {
      height: 280, x: yearLineX(share), y: { label: "WA share", tickFormat: "%", grid: true, zero: true },
      color: colorScale(),
      marks: [
        Plot.ruleY([popShare("WA") || 0], { stroke: css("--ink-3"), strokeDasharray: "4 4" }),
        Plot.lineY(share, { x: "year", y: "share", stroke: "source", strokeWidth: 2 }),
        Plot.dot(share, { x: "year", y: "share", fill: "source", r: 3 }),
        Plot.tip(share, Plot.pointer({ x: "year", y: "share", channels: { source: "source" }, format: { x: (d) => String(d), y: ".1%" } })),
      ],
    });

    waVsRest("#ov-pc", q(`SELECT round_year year, ${waExSums()} FROM grants g WHERE ${w} GROUP BY 1`, p));
  },

  wa() {
    const reg = $("#wa-region").value, rn = regionName(reg);
    const sci = ["COALESCE(g.field_group, '') <> 'Humanities & social sciences'"];
    const [w, p] = where([inRegion(reg), sci], { basic: true });
    const [wn, pn] = where([sci], { basic: true });
    const t = q(`SELECT COUNT(*) n, SUM(amount_aud) s FROM grants g WHERE ${w}`, p)[0];
    const nat = q(`SELECT SUM(amount_aud) s FROM grants g WHERE ${wn}`, pn)[0].s || 0;
    $("#wa-year-cap").textContent = `${rn}: basic science funding by year and funder (A$m)`;
    $("#wa-inst-cap").textContent = `${rn} institutions (A$m, selected years)`;
    $("#wa-field-cap").textContent = `${rn}: basic science by field of research (A$m, selected years)`;
    tiles("#wa-tiles", [
      [`${rn} basic science grants`, fmtInt(t.n), yearsLabel()],
      ["Amount", fmtB(t.s || 0), "ARC Discovery + NHMRC Basic Science"],
      ["Share of national basic science", nat ? fmtPct((t.s || 0) / nat) : "–", `share of ${perNoun()} ${popShare(reg) == null ? "–" : fmtPct(popShare(reg))}`],
      [`A$ ${perLabel()} per year`, fmtPer(per((t.s || 0) / (filters().to - filters().from + 1), popPeriod(reg))),
        "nominal, average over selected years"],
    ]);

    waVsRest("#wa-pc", q(`SELECT round_year year, ${waExSums()} FROM grants g WHERE ${wn} GROUP BY 1`, pn));
    stackedYears("#wa-year", q(`SELECT round_year year, source, SUM(amount_aud)/1e6 m FROM grants g WHERE ${w} GROUP BY 1,2`, p), 300);

    const st = q(`SELECT state, SUM(amount_aud) s FROM grants g WHERE ${wn} AND state IS NOT NULL GROUP BY 1`, pn)
      .filter((d) => POP[d.state]).map((d) => ({ ...d, percap: per(d.s, popPeriod(d.state)) })).filter((d) => d.percap != null);
    const inReg = statesOf(reg);
    if (!st.length) empty("#wa-percap");
    else plotInto("#wa-percap", {
      height: 260, marginLeft: 44, x: { label: `A$ ${perLabel()}, selected years`, grid: true },
      y: { label: null, domain: d3.sort(st, (d) => -d.percap).map((d) => d.state) },
      marks: [Plot.barX(st, { y: "state", x: "percap", rx: 2,
        fill: (d) => inReg.includes(d.state) ? css("--accent") : css("--muted-mark"), tip: { format: { percap: ",.0f", fill: false } } }),
      Plot.ruleX([0])],
    });

    stackedOrgs("#wa-inst", q(`SELECT o.name org, g.source, SUM(amount_aud)/1e6 m FROM grants g JOIN organisations o ON o.id=g.org_id
                               WHERE ${w} GROUP BY 1,2`, p));

    const fld = q(`SELECT for_division d, SUM(amount_aud)/1e6 m, COUNT(*) n FROM grants g
                   WHERE ${w} AND for_division IS NOT NULL GROUP BY 1 ORDER BY m DESC LIMIT 15`, p)
      .map((d) => ({ ...d, field: `${d.d} ${FOR_NAMES[d.d] || ""}` }));
    if (!fld.length) empty("#wa-field");
    else plotInto("#wa-field", {
      height: 40 + fld.length * 26, ...catY(fld.map((d) => d.field), 230), x: { label: "A$m", grid: true },
      marks: [Plot.barX(fld, { y: "field", x: "m", fill: css("--accent"), rx: 2, tip: { format: { m: ",.1f" } } }), Plot.ruleX([0])],
    });
  },

  inst() {
    const id = +$("#inst-pick").value;
    if (!id) return;
    const [w, p] = where([["g.org_id = ?", id]]);
    const t = q(`SELECT COUNT(*) n, SUM(amount_aud) s FROM grants g WHERE ${w}`, p)[0];
    const f = filters();
    const blk = q("SELECT SUM(amount_aud) s FROM block_grants WHERE org_id=? AND year BETWEEN ? AND ?", [id, f.from, f.to])[0].s;
    const blkLabel = "Research block grants";
    const inc = q("SELECT SUM(amount_aud) s FROM research_income WHERE org_id=? AND category='Total' AND year BETWEEN ? AND ?",
      [id, f.from, f.to])[0].s;
    tiles("#inst-tiles", [
      ["Competitive grants", fmtInt(t.n), yearsLabel()],
      ["Competitive amount", fmtB(t.s || 0), "selected funders"],
      [blkLabel, blk ? fmtB(blk) : "–", yearsLabel()],
      ["HERDC research income", inc ? fmtB(inc) : "–", yearsLabel()],
    ]);

    const byYear = q(`SELECT round_year year, source, SUM(amount_aud)/1e6 m FROM grants g WHERE ${w} GROUP BY 1,2`, p);
    if (!byYear.length) empty("#inst-year");
    else plotInto("#inst-year", {
      height: 280, x: yearX(), y: { label: "A$m", grid: true }, color: colorScale(),
      marks: [Plot.barY(byYear, { x: "year", y: "m", fill: "source", inset: 1, rx: 2, tip: { format: { x: (d) => String(d), m: ",.1f" } } }), Plot.ruleY([0])],
    });

    const b = q(`SELECT year, CASE WHEN program IN ('RTP','RSP') THEN program ELSE 'Earlier schemes' END program,
                 SUM(amount_aud)/1e6 m FROM block_grants WHERE org_id=? AND year BETWEEN ? AND ? GROUP BY 1,2`, [id, f.from, f.to]);
    if (!b.length) empty("#inst-block", "No block grant data for this organisation.");
    else plotInto("#inst-block", {
      height: 240, x: yearX(), y: { label: "A$m", grid: true },
      color: { domain: ["RTP", "RSP", "Earlier schemes"], range: [css("--s1"), css("--s2"), css("--s3")], legend: true },
      marks: [Plot.barY(b, { x: "year", y: "m", fill: "program", inset: 1, rx: 2, tip: { format: { x: (d) => String(d), m: ",.1f" } } }), Plot.ruleY([0])],
    });

    const h = q(`SELECT year, category, amount_aud/1e6 m FROM research_income
                 WHERE org_id=? AND category<>'Total' AND year BETWEEN ? AND ?`, [id, f.from, f.to]);
    const cats = ["Cat 1", "Cat 2", "Cat 3", "Cat 4"];
    if (!h.length) empty("#inst-herdc", "No HERDC data for this organisation.");
    else plotInto("#inst-herdc", {
      height: 240, x: yearX(), y: { label: "A$m", grid: true },
      color: { domain: cats, range: ["--s1", "--s2", "--s3", "--s4"].map(css), legend: true },
      marks: [Plot.barY(h, { x: "year", y: "m", fill: "category", inset: 1, rx: 2, tip: { format: { x: (d) => String(d), m: ",.1f" } } }), Plot.ruleY([0])],
    });

    table("#inst-schemes", q(`SELECT source, scheme, COUNT(*) n, SUM(amount_aud) s FROM grants g WHERE ${w}
                              GROUP BY 1,2 ORDER BY s DESC LIMIT 15`, p), [
      { key: "source", label: "Funder" }, { key: "scheme", label: "Scheme" },
      { label: "Grants", n: 1, f: (r) => fmtInt(r.n) }, { label: "Amount", n: 1, f: (r) => fmtM(r.s) },
    ]);

    const ph = q(`SELECT 'Philanthropy' kind, donor who, year, amount_aud, purpose, source_url FROM philanthropy WHERE org_id=?
                  UNION ALL SELECT 'WA Govt', program, year, amount_aud, purpose, source_url FROM state_programs WHERE org_id=?
                  ORDER BY year DESC`, [id, id]);
    table("#inst-phil", ph, [
      { key: "kind", label: "Type" }, { key: "who", label: "Donor / program" }, { key: "year", label: "Year" },
      { label: "Amount", n: 1, f: (r) => fmtM(r.amount_aud) }, { key: "purpose", label: "Purpose" },
      { label: "Source", f: (r) => r.source_url ? `<a href="${esc(r.source_url)}" rel="noopener">link</a>` : "" },
    ]);
  },

  search(limit = 500) {
    const extra = [];
    const s = $("#s-q").value.trim();
    if (s) {
      const like = `%${s}%`;
      extra.push(["(g.title LIKE ? OR g.lead_investigator LIKE ? OR g.scheme LIKE ? OR g.id LIKE ?)", like, like, like, like]);
    }
    if ($("#s-state").value) extra.push(["g.state = ?", $("#s-state").value]);
    const org = $("#s-org").value.trim();
    if (org) extra.push(["(o.name LIKE ? OR g.org_raw LIKE ?)", `%${org}%`, `%${org}%`]);
    const [w, p] = where(extra);
    const base = `FROM grants g LEFT JOIN organisations o ON o.id=g.org_id WHERE ${w}`;
    const cnt = q(`SELECT COUNT(*) n, SUM(amount_aud) s ${base}`, p)[0];
    const rows = q(`SELECT g.id, g.source, g.scheme, g.round_year year, g.title, g.lead_investigator lead,
                    COALESCE(o.name, g.org_raw) org, g.state, g.amount_aud, g.team_size team,
                    g.amount_aud / NULLIF(g.team_size, 0) per_inv, g.field_group field, g.basic_science basic
                    ${base} ORDER BY g.amount_aud DESC LIMIT ${limit}`, p);
    if (limit > 500) return rows;
    $("#s-count").textContent = `${fmtInt(cnt.n)} grants, ${fmtB(cnt.s || 0)}. ` +
      (cnt.n > 500 ? "Showing the 500 largest; the CSV includes up to 50,000." : "");
    table("#s-table", rows, [
      { key: "id", label: "ID" }, { key: "year", label: "Year" }, { key: "scheme", label: "Scheme" },
      { key: "title", label: "Title" }, { key: "lead", label: "Lead investigator" }, { key: "org", label: "Organisation" },
      { key: "state", label: "State" }, { label: "Amount", n: 1, f: (r) => fmtM(r.amount_aud) },
      { label: "Team", n: 1, f: (r) => r.team || "" }, { label: "Per investigator", n: 1, f: (r) => fmtM(r.per_inv) },
      { label: "Basic", f: (r) => r.basic ? "yes" : "" },
    ], "id");
  },

  other() {
    const ph = q(`SELECT p.donor, COALESCE(o.name, p.recipient_raw) recipient, p.year, p.amount_aud, p.purpose, p.source_url
                  FROM philanthropy p LEFT JOIN organisations o ON o.id=p.org_id ORDER BY p.year DESC, p.amount_aud DESC`);
    const byYear = d3.rollups(ph.filter((d) => d.year), (v) => d3.sum(v, (d) => d.amount_aud) / 1e6, (d) => d.year)
      .map(([year, m]) => ({ year, m }));
    if (!byYear.length) empty("#ph-year", "No philanthropy records loaded.");
    else plotInto("#ph-year", {
      height: 240, x: yearX(), y: { label: "A$m", grid: true },
      marks: [Plot.barY(byYear, { x: "year", y: "m", fill: css("--s5"), rx: 2, tip: { format: { x: (d) => String(d), m: ",.1f" } } }), Plot.ruleY([0])],
    });
    const link = (r) => r.source_url ? `<a href="${esc(r.source_url)}" rel="noopener">source</a>` : "";
    table("#ph-table", ph, [
      { key: "donor", label: "Donor" }, { key: "recipient", label: "Recipient" }, { key: "year", label: "Year" },
      { label: "Amount", n: 1, f: (r) => fmtM(r.amount_aud) }, { key: "purpose", label: "Purpose" }, { label: "", f: link },
    ]);
    const wa = q(`SELECT s.program, s.agency, COALESCE(o.name, s.recipient_raw) recipient, s.year, s.amount_aud, s.purpose, s.source_url
                  FROM state_programs s LEFT JOIN organisations o ON o.id=s.org_id ORDER BY s.year DESC, s.amount_aud DESC`);
    table("#wa-table", wa, [
      { key: "program", label: "Program" }, { key: "agency", label: "Agency" }, { key: "recipient", label: "Recipient" },
      { key: "year", label: "Year" }, { label: "Amount", n: 1, f: (r) => fmtM(r.amount_aud) },
      { key: "purpose", label: "Purpose" }, { label: "", f: link },
    ]);
  },

  bio() {
    const topic = $("#bio-topic").value, reg = $("#bio-state").value, ms = methodSQL();
    const st = regionName(reg), inReg = statesOf(reg);
    const [rs, ...rv] = inRegion(reg);
    const [w, p] = where([], { topic: null });
    const [wt, pt] = where([topicClause(topic)], { topic: null });
    $("#bio-share-cap").textContent = `${st} share of national funding in each topic (bars) against ${st} share of population (dashed line)`;
    $("#bio-trend-cap").textContent = `${topic} in ${st}, by year and funder (A$m)`;
    $("#bio-pc-cap").textContent = `${topic}: A$ ${perLabel()} by year, WA against the rest of Australia (${dollarsLabel()})`;
    $("#bio-inst-cap").textContent = `Top institutions in ${st}: ${topic} (A$m, selected years)`;
    $("#bio-people-cap").textContent = `Top researchers in ${st}: ${topic} (selected years, ${creditLabel()})`;

    const nat = q(`SELECT COUNT(*) n, SUM(amount_aud) s, SUM(CASE WHEN ${rs} THEN amount_aud END) st,
                   SUM(CASE WHEN ${rs} THEN 1 ELSE 0 END) stn FROM grants g WHERE ${wt}`, [...rv, ...rv, ...pt])[0];
    const byState = q(`SELECT state, SUM(amount_aud) s FROM grants g WHERE ${wt} AND state IS NOT NULL GROUP BY 1`, pt)
      .filter((d) => POP[d.state]).map((d) => ({ ...d, percap: per(d.s, popPeriod(d.state)) })).filter((d) => d.percap != null);
    const rank = inReg.length === 1 ? d3.sort(byState, (d) => -d.percap).findIndex((d) => d.state === reg) + 1 : 0;
    tiles("#bio-tiles", [
      [`${topic} grants in ${st}`, fmtInt(nat.stn || 0), yearsLabel()],
      ["Amount", fmtB(nat.st || 0), `of ${fmtB(nat.s || 0)} nationally`],
      [`${st} share`, nat.s ? fmtPct((nat.st || 0) / nat.s) : "–", `share of ${perNoun()} ${popShare(reg) == null ? "–" : fmtPct(popShare(reg))}`],
      [`A$ ${perLabel()}`, fmtPer(per(nat.st || 0, popPeriod(reg))), rank ? `rank ${rank} of ${byState.length} states` : "selected years"],
    ]);
    waVsRest("#bio-pc", q(`SELECT round_year year, ${waExSums()} FROM grants g WHERE ${wt} GROUP BY 1`, pt));

    const heat = q(`SELECT t.topic, g.round_year year, SUM(g.amount_aud)/1e6 m, COUNT(*) n FROM grants g
                    JOIN grant_topics t ON t.grant_id = g.id${ms} WHERE ${w} GROUP BY 1, 2`, p);
    if (!heat.length) empty("#bio-heat");
    else plotInto("#bio-heat", {
      height: 60 + TOPICS.length * 28, ...catY(TOPICS, 250), x: yearX({ axis: "top" }),
      color: { type: "sqrt", scheme: "blues", legend: true, label: "A$m" },
      marks: [Plot.cell(heat, { x: "year", y: "topic", fill: "m", inset: 0.5, tip: { format: { x: (d) => String(d), y: true, fill: ",.1f", n: true } },
        channels: { n: { value: "n", label: "grants" } } })],
    });

    const share = q(`SELECT t.topic, SUM(g.amount_aud) s, SUM(CASE WHEN ${rs} THEN g.amount_aud ELSE 0 END) st
                     FROM grants g JOIN grant_topics t ON t.grant_id = g.id${ms} WHERE ${w} GROUP BY 1`, [...rv, ...p])
      .map((d) => ({ ...d, share: d.s ? d.st / d.s : 0 }));
    if (!share.length) empty("#bio-share");
    else plotInto("#bio-share", {
      height: 60 + TOPICS.length * 26, ...catY(TOPICS, 250), x: { label: `${st} share of national`, tickFormat: "%", grid: true },
      marks: [
        Plot.barX(share, { y: "topic", x: "share", rx: 2, tip: { format: { share: ".1%", fill: false } },
          fill: (d) => d.topic === topic ? css("--accent") : css("--muted-mark") }),
        Plot.ruleX([popShare(reg) || 0], { stroke: css("--ink"), strokeDasharray: "4 3" }),
        Plot.ruleX([0]),
      ],
    });

    stackedYears("#bio-trend", q(`SELECT round_year year, source, SUM(amount_aud)/1e6 m FROM grants g
                                  WHERE ${wt} AND ${rs} GROUP BY 1, 2`, [...pt, ...rv]));

    if (!byState.length) empty("#bio-percap");
    else plotInto("#bio-percap", {
      height: 260, marginLeft: 44, x: { label: `A$ ${perLabel()}`, grid: true },
      y: { label: null, domain: d3.sort(byState, (d) => -d.percap).map((d) => d.state) },
      marks: [Plot.barX(byState, { y: "state", x: "percap", rx: 2, tip: { format: { percap: ",.2f", fill: false } },
        fill: (d) => inReg.includes(d.state) ? css("--accent") : css("--muted-mark") }), Plot.ruleX([0])],
    });

    stackedOrgs("#bio-inst", q(`SELECT o.name org, g.source, SUM(amount_aud)/1e6 m FROM grants g
                                JOIN organisations o ON o.id = g.org_id WHERE ${wt} AND ${rs} GROUP BY 1, 2`, [...pt, ...rv]));

    table("#bio-people", q(`SELECT i.name_key k, MAX(i.name) name, COUNT(*) n, SUM(${creditAmt()}) s,
                            MIN(g.round_year) y0, MAX(g.round_year) y1, GROUP_CONCAT(DISTINCT COALESCE(o.name, g.org_raw)) orgs
                            FROM ${peopleSQL()} i JOIN grants g ON g.id = i.grant_id LEFT JOIN organisations o ON o.id = g.org_id
                            WHERE ${wt} AND ${rs} GROUP BY 1 ORDER BY s DESC LIMIT 25`, [...pt, ...rv]), [
      { label: "Researcher", f: (r) => who(r.k, r.name) }, { label: "Grants", n: 1, f: (r) => fmtInt(r.n) },
      { label: "Total", n: 1, f: (r) => fmtM(r.s) }, { label: "Years", n: 1, f: (r) => `${r.y0}–${r.y1}` },
      { label: "Organisations", f: (r) => orgList(r.orgs) },
    ]);

    table("#bio-grants", q(`SELECT g.id, g.round_year year, g.source, g.scheme, g.title, g.lead_investigator lead,
                            (SELECT name_key FROM investigators WHERE grant_id = g.id AND role = 'lead') k,
                            COALESCE(o.name, g.org_raw) org, g.amount_aud
                            FROM grants g LEFT JOIN organisations o ON o.id = g.org_id
                            WHERE ${wt} AND ${rs} ORDER BY g.amount_aud DESC LIMIT 25`, [...pt, ...rv]), [
      { key: "year", label: "Year" }, { key: "scheme", label: "Scheme" }, { key: "title", label: "Title" },
      { label: "Lead", f: (r) => who(r.k, r.lead) }, { key: "org", label: "Organisation" },
      { label: "Amount", n: 1, f: (r) => fmtM(r.amount_aud) },
    ], "id");
  },

  people() {
    $("#p-profile").hidden = !personKey;
    $("#p-board-card").hidden = !!personKey;
    if (personKey) return views.profile(personKey);
    const extra = [];
    const st = $("#p-state").value, role = $("#p-role").value, s = $("#p-q").value.trim();
    if (st) extra.push(inRegion(st));
    if (s) extra.push(["(i.name LIKE ? OR i.name_key LIKE ?)", `%${s}%`, `%${s.toLowerCase()}%`]);
    const [w, p] = where(extra);
    const f = filters();
    $("#p-board-cap").textContent = `Most funded researchers${st ? ` on ${regionName(st)} grants` : ""}${f.topic ? ` in ${f.topic}` : ""}, ${yearsLabel()}` +
      `${role ? " (lead only)" : ""}, ${creditLabel()}. Click a name for their profile.`;
    table("#p-board", q(`SELECT i.name_key k, MAX(i.name) name, COUNT(*) n, SUM(${creditAmt()}) s, SUM(g.amount_aud) fullv,
                         SUM(CASE WHEN i.role = 'lead' THEN 1 ELSE 0 END) led, MIN(g.round_year) y0, MAX(g.round_year) y1,
                         GROUP_CONCAT(DISTINCT g.source) funders, GROUP_CONCAT(DISTINCT COALESCE(o.name, g.org_raw)) orgs
                         FROM ${peopleSQL(role)} i JOIN grants g ON g.id = i.grant_id LEFT JOIN organisations o ON o.id = g.org_id
                         WHERE ${w} GROUP BY 1 ORDER BY s DESC LIMIT 100`, p), [
      { label: "Researcher", f: (r) => who(r.k, r.name) }, { label: "Grants", n: 1, f: (r) => fmtInt(r.n) },
      { label: "As lead", n: 1, f: (r) => fmtInt(r.led) }, { label: "Credited", n: 1, f: (r) => fmtM(r.s) },
      { label: "Full value of grants", n: 1, f: (r) => fmtM(r.fullv) },
      { label: "Years", n: 1, f: (r) => `${r.y0}–${r.y1}` }, { label: "Funders", f: (r) => esc((r.funders || "").split(",").join(", ")) }, { label: "Organisations", f: (r) => orgList(r.orgs) },
    ]);
  },

  profile(key, csv) {
    const [w, p] = where([["i.name_key = ?", key]]);
    const grants = q(`SELECT g.id, g.round_year year, g.source, g.scheme, g.title, i.role, g.lead_investigator lead,
                      COALESCE(o.name, g.org_raw) org, o.domain domain, g.state, g.amount_aud, g.team_size team, ${creditAmt()} credit,
                      g.basic_science basic
                      FROM ${peopleSQL()} i JOIN grants g ON g.id = i.grant_id LEFT JOIN organisations o ON o.id = g.org_id
                      WHERE ${w} ORDER BY g.round_year DESC, g.amount_aud DESC`, p);
    if (csv) return grants;
    const name = q("SELECT name, COUNT(*) c FROM investigators WHERE name_key = ? GROUP BY 1 ORDER BY c DESC LIMIT 1", [key])[0];
    $("#p-name").textContent = name ? name.name : key;
    const latest = grants.find((g) => g.org) || {};
    $("#p-links").innerHTML = `<span class="note">Search for this person${latest.org ? ` (most recent organisation: ${esc(latest.org)})` : ""}:</span> ` +
      personLinks(name ? name.name : key, latest.org, latest.domain);
    const orgs = [...new Set(grants.map((g) => g.org).filter(Boolean))];
    const yrs = grants.map((g) => g.year).filter(Boolean);
    tiles("#p-tiles", [
      ["Grants", fmtInt(grants.length), `${grants.filter((g) => g.role === "lead").length} as lead`],
      ["Credited", fmtB(d3.sum(grants, (g) => g.credit)), `${creditLabel()}; full value ${fmtB(d3.sum(grants, (g) => g.amount_aud))}`],
      ["Active", yrs.length ? `${d3.min(yrs)}–${d3.max(yrs)}` : "–", "within selected years and funders"],
      ["Organisations", fmtInt(orgs.length), orgs.slice(0, 2).join("; ") + (orgs.length > 2 ? "…" : "")],
    ]);
    stackedYears("#p-year", d3.rollups(grants, (v) => d3.sum(v, (g) => g.credit) / 1e6, (g) => g.year, (g) => g.source)
      .flatMap(([year, xs]) => xs.map(([source, m]) => ({ year, source, m }))), 240);

    const ms = methodSQL();
    const tops = q(`SELECT t.topic, SUM(${creditAmt()})/1e6 m, COUNT(*) n FROM ${peopleSQL()} i JOIN grants g ON g.id = i.grant_id
                    JOIN grant_topics t ON t.grant_id = g.id${ms} WHERE ${w} GROUP BY 1 ORDER BY m DESC`, p);
    if (!tops.length) empty("#p-topics", "No biology topics tagged on these grants.");
    else plotInto("#p-topics", {
      height: 40 + tops.length * 26, ...catY(tops.map((d) => d.topic), 250), x: { label: "A$m", grid: true },
      marks: [Plot.barX(tops, { y: "topic", x: "m", fill: css("--accent"), rx: 2, tip: { format: { m: ",.2f" } } }), Plot.ruleX([0])],
    });

    table("#p-coi", q(`SELECT j.name_key k, MAX(j.name) name, COUNT(DISTINCT g.id) n, SUM(g.amount_aud) s
                       FROM ${peopleSQL()} i JOIN ${peopleSQL()} j ON j.grant_id = i.grant_id AND j.name_key <> i.name_key
                       JOIN grants g ON g.id = i.grant_id WHERE ${w} GROUP BY 1 ORDER BY n DESC, s DESC LIMIT 30`, p), [
      { label: "Co-investigator", f: (r) => who(r.k, r.name) }, { label: "Shared grants", n: 1, f: (r) => fmtInt(r.n) },
      { label: "Value of shared grants", n: 1, f: (r) => fmtM(r.s) },
    ]);
    $("#p-grants-note").textContent = grants.length > 200 ? `Showing the latest 200 of ${fmtInt(grants.length)}; the CSV has all.` : "";
    table("#p-grants", grants.slice(0, 200), [
      { key: "year", label: "Year" }, { key: "source", label: "Funder" }, { key: "scheme", label: "Scheme" },
      { key: "title", label: "Title" }, { key: "role", label: "Role" }, { key: "org", label: "Organisation" },
      { label: "Grant value", n: 1, f: (r) => fmtM(r.amount_aud) }, { label: "Team", n: 1, f: (r) => r.team || "" },
      { label: "Credited", n: 1, f: (r) => fmtM(r.credit) }, { label: "Basic", f: (r) => r.basic ? "yes" : "" },
    ], "id");
  },

  blocks() {
    const f = filters();
    const yr = [f.from, f.to];
    const grp = `CASE WHEN b.program IN ('RTP','RSP') THEN b.program ELSE 'Earlier schemes' END`;
    const base = `FROM block_grants b JOIN organisations o ON o.id = b.org_id
                  WHERE b.year BETWEEN ? AND ? AND b.program NOT LIKE '%total%'`;
    const tot = q(`SELECT SUM(b.amount_aud) s, SUM(CASE WHEN o.state='WA' THEN b.amount_aud END) wa ${base}`, yr)[0];
    const last = q(`SELECT MAX(b.year) y ${base}`, yr)[0].y;
    const lastWA = last ? q(`SELECT SUM(b.amount_aud) s ${base} AND b.year = ? AND o.state = 'WA'`, [...yr, last])[0].s : null;
    const nyrs = f.to - f.from + 1;
    tiles("#blk-tiles", [
      ["National block grants", fmtB(tot.s || 0), yearsLabel()],
      ["To WA universities", fmtB(tot.wa || 0), `WA share ${tot.s ? fmtPct((tot.wa || 0) / tot.s) : "–"}, ${perNoun()} ${popShare("WA") == null ? "–" : fmtPct(popShare("WA"))}`],
      [`WA ${perLabel()} per year`, fmtPer(per((tot.wa || 0) / nyrs, popPeriod("WA"))), "nominal, selected years"],
      [`Rest of Australia ${perLabel()} per year`, fmtPer(per(((tot.s || 0) - (tot.wa || 0)) / nyrs, popPeriod("EXWA"))),
        `WA in ${last || "latest year"}: ${lastWA ? fmtM(lastWA) : "–"}`],
    ]);
    waVsRest("#blk-pc", q(`SELECT b.year, ${waExSums("b.amount_aud", "o.state")} ${base} GROUP BY 1`, yr));

    const byYear = q(`SELECT b.year, ${grp} program, SUM(b.amount_aud)/1e6 m ${base} GROUP BY 1, 2`, yr);
    const progs = ["RTP", "RSP", "Earlier schemes"];
    if (!byYear.length) empty("#blk-year", "No block grant data loaded.");
    else plotInto("#blk-year", {
      height: 280, x: yearX(), y: { label: "A$m", grid: true },
      color: { domain: progs, range: ["--s1", "--s2", "--s3"].map(css), legend: true },
      marks: [Plot.barY(byYear, { x: "year", y: "m", fill: "program", inset: 1, rx: 2, tip: { format: { x: (d) => String(d), m: ",.1f" } } }), Plot.ruleY([0])],
    });

    const bs = q(`SELECT o.state, SUM(b.amount_aud) s ${base} AND o.state IS NOT NULL GROUP BY 1`, yr);
    const total = d3.sum(bs, (d) => d.s);
    const rows = STATES.map((st) => {
      const r = bs.find((d) => d.state === st) || { s: 0 };
      return { state: st, share: total ? r.s / total : 0, pop: popShare(st) || 0, s: r.s };
    });
    if (!total) empty("#blk-state");
    else plotInto("#blk-state", {
      height: 260, marginLeft: 44, x: { label: "share of national block grants", tickFormat: "%", grid: true },
      y: { label: null, domain: STATES },
      marks: [
        Plot.barX(rows, { y: "state", x: "share", rx: 2, tip: { format: { share: ".1%", fill: false } },
          fill: (d) => d.state === "WA" ? css("--accent") : css("--muted-mark") }),
        Plot.tickX(rows, { y: "state", x: "pop", stroke: css("--ink"), strokeWidth: 2 }),
        Plot.ruleX([0]),
      ],
    });

    const wa = q(`SELECT b.year, o.name uni, SUM(b.amount_aud)/1e6 m ${base} AND o.state = 'WA' GROUP BY 1, 2`, yr);
    const unis = d3.groupSort(wa, (v) => -d3.sum(v, (d) => d.m), (d) => d.uni);
    if (!wa.length) empty("#blk-wa");
    else plotInto("#blk-wa", {
      height: 300, x: yearLineX(wa), y: { label: "A$m", grid: true },
      color: { domain: unis, range: ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"].map(css), legend: true },
      marks: [
        Plot.lineY(wa, { x: "year", y: "m", stroke: "uni", strokeWidth: 2 }),
        Plot.dot(wa, { x: "year", y: "m", fill: "uni", r: 2.5 }),
        Plot.tip(wa, Plot.pointer({ x: "year", y: "m", channels: { uni: "uni" }, format: { x: (d) => String(d), y: ",.1f" } })),
      ],
    });

    const share = q(`SELECT b.year, SUM(CASE WHEN o.state='WA' THEN b.amount_aud ELSE 0 END)/SUM(b.amount_aud) share
                     ${base} GROUP BY 1 HAVING SUM(b.amount_aud) > 0`, yr);
    if (!share.length) empty("#blk-share");
    else plotInto("#blk-share", {
      height: 240, x: yearLineX(share), y: { label: "WA share", tickFormat: "%", grid: true, zero: true },
      marks: [
        Plot.ruleY([popShare("WA") || 0], { stroke: css("--ink-3"), strokeDasharray: "4 4" }),
        Plot.lineY(share, { x: "year", y: "share", stroke: css("--accent"), strokeWidth: 2, tip: { format: { x: (d) => String(d), y: ".1%" } } }),
      ],
    });

    const [w, p] = where([], { topic: null, basic: false });
    const comp = new Map(q(`SELECT org_id, SUM(amount_aud) s FROM grants g WHERE ${w} GROUP BY 1`, p).map((r) => [r.org_id, r.s]));
    const avgStat = (tbl, col) => new Map(q(`SELECT org_id, AVG(${col}) v FROM ${tbl} WHERE year BETWEEN ? AND ? GROUP BY 1`, yr)
      .map((r) => [r.org_id, r.v]));
    const studs = avgStat("student_stats", "students"), hdrs = avgStat("student_stats", "hdr_students"),
      acad = avgStat("staff_stats", "academic_fte");
    const unisAll = q(`SELECT o.id, o.name, o.state, SUM(b.amount_aud) blk,
                       SUM(CASE WHEN ${grp} = 'RTP' THEN b.amount_aud END) rtp,
                       SUM(CASE WHEN ${grp} = 'RSP' THEN b.amount_aud END) rsp
                       ${base} GROUP BY 1 ORDER BY blk DESC`, yr)
      .map((r) => ({ ...r, comp: comp.get(r.id) || 0, ratio: comp.get(r.id) ? r.blk / comp.get(r.id) : null }))
      .filter((r) => !$("#blk-region").value || statesOf($("#blk-region").value).includes(r.state))
      .map((r) => ({ ...r, students: studs.get(r.id), hdr: hdrs.get(r.id), acad: acad.get(r.id) }));
    unisAll.forEach((r, i) => { r.rank = i + 1; });
    table("#blk-table", unisAll, [
      { label: "#", n: 1, f: (r) => r.rank }, { label: "University", f: (r) => r.state === "WA" ? `<b>${esc(r.name)}</b>` : esc(r.name) },
      { key: "state", label: "State" }, { label: "Block grants", n: 1, f: (r) => fmtM(r.blk) },
      { label: "RTP", n: 1, f: (r) => fmtM(r.rtp) }, { label: "RSP", n: 1, f: (r) => fmtM(r.rsp) },
      { label: "Competitive grants", n: 1, f: (r) => fmtM(r.comp) },
      { label: "Block / competitive", n: 1, f: (r) => r.ratio == null ? "–" : d3.format(".2f")(r.ratio) },
      { label: "Students (avg)", n: 1, f: (r) => (r.students ? fmtInt(Math.round(r.students)) : "–") },
      { label: "Academic FTE (avg)", n: 1, f: (r) => (r.acad ? fmtInt(Math.round(r.acad)) : "–") },
      { label: "RTP per research student / yr", n: 1, f: (r) => fmtPer(per((r.rtp || 0) / nyrs, r.hdr), 0) },
      { label: "Block per academic / yr", n: 1, f: (r) => fmtPer(per(r.blk / nyrs, r.acad), 0) },
      { label: "Competitive per academic / yr", n: 1, f: (r) => fmtPer(per(r.comp / nyrs, r.acad), 0) },
    ]);
  },

  async trends() {
    if (!views._analysis) {
      views._analysis = await fetch("data/analysis.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    }
    const a = views._analysis;
    if (!a) { $("#tr-findings").innerHTML = '<p class="note">Trend analysis not available yet.</p>'; return; }
    const m = a.meta;
    $("#tr-meta").textContent = `Basic science = ARC Discovery program + NHMRC Basic Science, excluding humanities and social sciences. ` +
      `Complete years to ${m.last_complete_year}; trend window ${m.window ? m.window.join("–") : "n/a"}. ` +
      `${m.real_dollars ? `Amounts in ${m.base_year} dollars (ABS CPI)` : "Nominal dollars (CPI unavailable)"}; ` +
      `per resident ${m.population_by_year ? "uses each year's ABS population" : "uses 2024 population"}.`;
    $("#tr-findings").innerHTML = `<ul>${a.findings.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`;

    const lab = { WA: "WA", EXWA: "Australia excl. WA" };
    const col = { domain: ["WA", "Australia excl. WA"], range: [css("--s1"), css("--s2")], legend: true };
    const lines = (sel, key, label, fmt = ",.2f", src = a.series) => {
      const data = Object.entries(src).flatMap(([r, xs]) => xs.map((e) => ({ year: e.year, region: lab[r], v: e[key] })))
        .filter((d) => d.v != null);
      if (!data.length) return empty(sel);
      plotInto(sel, {
        height: 260, x: yearLineX(data), y: { label, grid: true, zero: true }, color: col,
        marks: [Plot.lineY(data, { x: "year", y: "v", stroke: "region", strokeWidth: 2 }),
          Plot.dot(data, { x: "year", y: "v", fill: "region", r: 2.5 }),
          Plot.tip(data, Plot.pointer({ x: "year", y: "v", channels: { region: "region" }, format: { x: (d) => String(d), y: fmt } }))],
      });
    };
    const dl = m.real_dollars ? `${m.base_year} dollars` : "nominal";
    lines("#tr-pc", "per_capita_real", `A$ per resident (${dl})`);
    lines("#tr-acad", "per_academic_real", `A$ per academic, university FTE (${dl})`, "$,.0f");
    lines("#tr-hdr", "per_hdr_real", `A$ per research student (${dl})`, "$,.0f");
    lines("#tr-grants", "grants", "grants per year", ",d");
    lines("#tr-mean", "mean_grant_real", `average grant, A$ (${dl})`, "$,.0f");
    lines("#tr-team", "arc_team", "average named investigators per ARC grant", ".2f");
    lines("#tr-perinv", "per_investigator_real", `A$ per named investigator, ARC (${dl})`, "$,.0f", a.per_investigator);

    const sh = a.share.filter((d) => d.wa_share != null);
    if (!sh.length) empty("#tr-share");
    else plotInto("#tr-share", {
      height: 240, x: yearLineX(sh), y: { label: "WA share of national basic science", tickFormat: "%", grid: true, zero: true },
      marks: [Plot.ruleY([POP.WA / POP_TOTAL], { stroke: css("--ink-3"), strokeDasharray: "4 4" }),
        Plot.lineY(sh, { x: "year", y: "wa_share", stroke: css("--accent"), strokeWidth: 2, tip: { format: { x: (d) => String(d), y: ".1%" } } })],
    });

    const tp = a.topics.flatMap((t) => [
      { topic: t.topic, region: "WA", v: t.WA_change }, { topic: t.topic, region: "Australia excl. WA", v: t.EXWA_change },
    ]).filter((d) => d.v != null && isFinite(d.v));
    if (!tp.length) empty("#tr-topics");
    else {
      const order = a.topics.map((t) => t.topic);
      plotInto("#tr-topics", {
        height: 40 + order.length * 30, ...catY(order, 250),
        x: { label: "change per resident, second half of window vs first", tickFormat: "+.0%", grid: true },
        color: col,
        marks: [Plot.ruleX([0]),
          Plot.ruleY(a.topics, { y: "topic", x1: "WA_change", x2: "EXWA_change", stroke: css("--line"), strokeWidth: 2 }),
          Plot.dot(tp, { y: "topic", x: "v", fill: "region", r: 5, tip: { format: { v: "+.1%" } } })],
      });
    }
    table("#tr-topic-tbl", a.topics, [
      { key: "topic", label: "Topic" },
      { label: "WA per resident, early", n: 1, f: (r) => d3.format("$.2f")(r.WA_early) },
      { label: "WA, recent", n: 1, f: (r) => d3.format("$.2f")(r.WA_late) },
      { label: "WA change", n: 1, f: (r) => (r.WA_change == null ? "–" : d3.format("+.0%")(r.WA_change)) },
      { label: "Rest, early", n: 1, f: (r) => d3.format("$.2f")(r.EXWA_early) },
      { label: "Rest, recent", n: 1, f: (r) => d3.format("$.2f")(r.EXWA_late) },
      { label: "Rest change", n: 1, f: (r) => (r.EXWA_change == null ? "–" : d3.format("+.0%")(r.EXWA_change)) },
      { label: "WA vs rest, recent", n: 1, f: (r) => (r.EXWA_late ? d3.format(".2f")(r.WA_late / r.EXWA_late) + "×" : "–") },
    ]);
    table("#tr-inst", a.institutions.slice(0, 15), [
      { key: "org", label: "WA institution" }, { label: "Previous 5 years", n: 1, f: (r) => fmtM(r.prev5) },
      { label: "Last 5 years", n: 1, f: (r) => fmtM(r.last5) },
      { label: "Change", n: 1, f: (r) => (r.change == null ? "new" : d3.format("+.0%")(r.change)) },
    ]);
  },

  about() {
    table("#ab-sources", q("SELECT * FROM sources"), [
      { key: "name", label: "Source" }, { key: "status", label: "Status" }, { label: "Rows", n: 1, f: (r) => fmtInt(r.rows) },
      { key: "fetched_at", label: "Fetched (UTC)" },
      { label: "From", f: (r) => (r.url || "").split(", ").filter((u) => u.startsWith("http"))
        .map((u) => `<a href="${esc(u)}" rel="noopener">${esc(new URL(u).hostname)}</a>`).join(" ") || esc(r.url) },
      { key: "note", label: "Note" },
    ]);
  },
};

/* ---------- grant detail ---------- */
const SOURCE_PAGES = {
  NHMRC: "https://www.nhmrc.gov.au/funding/data-research/outcomes",
  MRFF: "https://www.health.gov.au/resources/publications/medical-research-future-fund-mrff-grant-recipients",
  CRC: "https://business.gov.au/grants-and-programs/cooperative-research-centres-projects-crcp-grants/crc-projects-selection-round-outcomes",
};
const summaryCache = new Map();

async function summaryFor(id) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(id));
  const key = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 2);
  if (!summaryCache.has(key)) {
    summaryCache.set(key, fetch(`data/summaries/${key}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
  }
  return (await summaryCache.get(key))[id];
}

function sourceLink(g) {
  const code = g.id.split(":").slice(1).join(":");
  if (g.source === "ARC") return [`https://dataportal.arc.gov.au/NCGP/Web/Grant/Grant/${encodeURIComponent(code)}`, "ARC Data Portal record"];
  return SOURCE_PAGES[g.source] ? [SOURCE_PAGES[g.source], `${g.source} outcomes (source list)`] : null;
}

async function openGrant(id) {
  const g = q(`SELECT g.*, o.name org_name, o.type org_type, o.domain org_domain FROM grants g LEFT JOIN organisations o ON o.id = g.org_id
               WHERE g.id = ?`, [id])[0];
  if (!g) return;
  const people = q(`SELECT name_key k, MAX(name) name, GROUP_CONCAT(DISTINCT role) roles FROM investigators
                    WHERE grant_id = ? GROUP BY 1 ORDER BY MAX(role = 'lead') DESC, name`, [id]);
  const topics = q("SELECT topic, method FROM grant_topics WHERE grant_id = ? ORDER BY topic", [id]);
  const div = g.for_division ? `${g.for_division} ${FOR_NAMES[g.for_division] || ""}` : null;
  const link = sourceLink(g);
  const row = (k, v) => (v == null || v === "" ? "" : `<dt>${esc(k)}</dt><dd>${v}</dd>`);
  $("#gd-title").textContent = g.title || g.id;
  $("#gd-body").innerHTML = `
    <div class="gd-amount">${g.amount_aud != null ? d3.format("$,.0f")(g.amount_aud) : "Amount not published"}</div>
    <dl class="gd">
      ${row("Per investigator", g.team_size ? `${d3.format("$,.0f")(g.amount_aud / g.team_size)} <span class="note">(${g.team_size} named${g.source === "ARC" ? "" : "; this funder publishes the lead only"})</span>` : null)}
      ${row("Grant ID", esc(g.id.split(":").slice(1).join(":")))}
      ${row("Funder", esc(g.source))}
      ${row("Scheme", esc(g.scheme))}
      ${row("Year", esc(g.round_year))}
      ${row("Administering organisation", esc(g.org_name || g.org_raw) + (g.state ? ` (${esc(g.state)})` : ""))}
      ${row(people.length > 1 ? "Investigators" : "Investigator",
        people.map((p) => {
          const lead = (p.roles || "").includes("lead");
          // only the lead is known to be at the administering organisation
          return `<div class="gd-person">${who(p.k, p.name)}${lead ? ' <span class="note">lead</span>' : ""}` +
            personLinks(p.name, lead ? g.org_name : null, lead ? g.org_domain : null) + "</div>";
        }).join(""))}
      ${row("Field of Research", g.for_code ? `${esc(g.for_code)}${div ? ` <span class="note">(${esc(div)})</span>` : ""}` : null)}
      ${row("Field group", esc(g.field_group))}
      ${row("Research area", esc(g.research_area))}
      ${row("Biology topics", topics.map((t) => `${esc(t.topic)}${t.method === "keyword" ? ' <span class="note">(keyword)</span>' : ""}`).join("<br>"))}
      ${row("Basic / discovery", g.basic_science ? "Yes" : "No")}
    </dl>
    <h3>Summary</h3><p id="gd-summary" class="note">Loading…</p>
    ${link ? `<p><a href="${esc(link[0])}" target="_blank" rel="noopener">${esc(link[1])} ↗</a></p>` : ""}`;
  const dlg = $("#grant-dlg");
  if (!dlg.open) dlg.showModal();
  dlg.scrollTop = 0;
  const text = await summaryFor(id);
  const el = $("#gd-summary");
  if (el) { el.className = text ? "" : "note"; el.textContent = text || "No summary published for this grant."; }
}

/* ---------- wiring ---------- */
let current = "overview";
const FILTER_TABS = new Set(["overview", "wa", "bio", "people", "blocks", "inst", "search"]);

function show(tab) {
  current = tab;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  document.querySelectorAll("[data-panel]").forEach((s) => { s.hidden = s.dataset.panel !== tab; });
  $("#filters").hidden = !FILTER_TABS.has(tab);
  $("#f-basic").parentElement.hidden = tab === "wa";
  $("#f-topic-wrap").hidden = tab === "bio" || tab === "blocks";
  $("#f-credit-wrap").hidden = !(tab === "bio" || tab === "people");
  $("#f-per-wrap").hidden = !["overview", "wa", "bio", "blocks"].includes(tab);
  // block grants are formula funding: only the year range applies (funders feed the comparison column)
  ["#f-field-wrap", "#f-kw-wrap"].forEach((s) => { $(s).hidden = tab === "blocks"; });
  if (tab === "blocks") $("#f-basic").parentElement.hidden = true;
  history.replaceState(null, "", `#${tab}`);
  render();
}

function render() {
  document.querySelectorAll(".per-lbl").forEach((e) => { e.textContent = perLabel(); });
  document.querySelectorAll(".per-noun").forEach((e) => { e.textContent = perNoun(); });
  try { const r = views[current](); if (r && r.catch) r.catch((e) => console.error(e)); } catch (e) { console.error(e); }
}

async function init() {
  const SQL = await initSqlJs({ locateFile: (f) => `vendor/${f}` });
  const resp = await fetch("data/funding.sqlite");
  if (!resp.ok) throw new Error(`database not found (${resp.status})`);
  db = new SQL.Database(new Uint8Array(await resp.arrayBuffer()));

  const yr = q("SELECT MIN(round_year) a, MAX(round_year) b FROM grants WHERE round_year >= 1990")[0];
  const lo = yr.a || 2000, hi = yr.b || new Date().getFullYear();
  for (let y = lo; y <= hi; y++) {
    $("#f-from").add(new Option(y, y)); $("#f-to").add(new Option(y, y));
  }
  $("#f-from").value = Math.max(lo, hi - 14); $("#f-to").value = hi;

  const present = q("SELECT DISTINCT source FROM grants").map((r) => r.source);
  GRANT_SOURCES.forEach((s, i) => {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" value="${s}" ${present.includes(s) ? "checked" : "disabled"}>` +
      `<span class="swatch" style="background:var(--s${i + 1})"></span>${s}`;
    $("#f-sources").append(l);
  });
  for (const r of q("SELECT DISTINCT field_group f FROM grants WHERE f IS NOT NULL ORDER BY 1")) $("#f-field").add(new Option(r.f, r.f));
  for (const sel of ["#bio-state", "#p-state"]) {
    $(sel).add(new Option("Australia excl. WA", "EXWA"));
    if (sel === "#bio-state") $(sel).add(new Option("Australia", "AUS"));
  }
  STATES.forEach((s) => {
    $("#s-state").add(new Option(s, s)); $("#bio-state").add(new Option(s, s)); $("#p-state").add(new Option(s, s));
  });
  try {
    for (const r of q(`SELECT o.state, s.year, SUM(s.students) st, SUM(s.hdr_students) h, COUNT(*) n FROM student_stats s
                        JOIN organisations o ON o.id = s.org_id WHERE o.state IS NOT NULL GROUP BY 1, 2`)) {
      (DENOM.student[r.state] ||= {})[r.year] = r.st;
      if (r.h) (DENOM.hdr[r.state] ||= {})[r.year] = r.h;
      (DENOM.uni[r.state] ||= {})[r.year] = r.n;
    }
    for (const r of q(`SELECT o.state, s.year, SUM(s.academic_fte) a FROM staff_stats s
                        JOIN organisations o ON o.id = s.org_id WHERE o.state IS NOT NULL GROUP BY 1, 2`)) {
      (DENOM.staff[r.state] ||= {})[r.year] = r.a;
    }
  } catch (e) { /* older database without HE statistics */ }
  for (const k of Object.keys(DENOM)) {
    const opt = $(`#f-per option[value="${k}"]`);
    if (opt && !Object.keys(DENOM[k]).length) { opt.disabled = true; opt.textContent += " (no data yet)"; }
  }
  try {
    for (const r of q("SELECT state, year, persons FROM population")) (POPY[r.state] ||= {})[r.year] = r.persons;
    for (const r of q("SELECT year, idx FROM cpi")) CPI[r.year] = r.idx;
  } catch (e) { /* older database without ABS tables */ }
  const present_topics = new Set(q("SELECT DISTINCT topic FROM grant_topics").map((r) => r.topic));
  TOPICS.filter((t) => present_topics.has(t)).forEach((t) => {
    $("#f-topic").add(new Option(t, t)); $("#bio-topic").add(new Option(t, t));
  });
  $("#bio-state").value = "WA";

  const orgs = q(`SELECT o.id, o.name, o.state, COALESCE(SUM(g.amount_aud),0) s FROM organisations o
                  LEFT JOIN grants g ON g.org_id=o.id GROUP BY o.id
                  HAVING s > 0 OR o.id IN (SELECT org_id FROM block_grants) OR o.id IN (SELECT org_id FROM philanthropy)
                  ORDER BY (o.state='WA') DESC, s DESC`);
  for (const o of orgs) $("#inst-pick").add(new Option(`${o.name}${o.state ? ` (${o.state})` : ""}`, o.id));

  const meta = await fetch("data/meta.json").then((r) => r.ok ? r.json() : {}).catch(() => ({}));
  $("#ab-built").textContent = meta.built ? new Date(meta.built).toLocaleString("en-AU") : "unknown";

  let timer;
  document.querySelectorAll("#filters select, #filters input").forEach((el) => el.addEventListener("change", render));
  $("#inst-pick").addEventListener("change", render);
  ["#bio-topic", "#bio-state", "#p-state", "#p-role", "#wa-region", "#blk-region"].forEach((s) => $(s).addEventListener("change", render));
  $("#p-q").addEventListener("input", () => { personKey = null; clearTimeout(timer); timer = setTimeout(render, 250); });
  document.addEventListener("click", onSortClick);
  document.addEventListener("keydown", onSortClick);
  document.addEventListener("keydown", (e) => {
    const row = e.target.closest && e.target.closest("tr[data-grant]");
    if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openGrant(row.dataset.grant); }
  });
  $("#gd-close").addEventListener("click", () => $("#grant-dlg").close());
  $("#grant-dlg").addEventListener("click", (e) => { if (e.target.id === "grant-dlg") e.target.close(); });
  $("#p-back").addEventListener("click", () => { personKey = null; render(); });
  $("#p-csv").addEventListener("click", () => personKey && downloadCSV(`${personKey.replace("|", "_")}.csv`, views.profile(personKey, true)));
  document.addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-grant]");
    if (row && !e.target.closest("a")) { openGrant(row.dataset.grant); return; }
    const a = e.target.closest("a.who");
    if (!a) return;
    e.preventDefault();
    if ($("#grant-dlg").open) $("#grant-dlg").close();
    personKey = a.dataset.key;
    if (current === "people") { render(); window.scrollTo(0, 0); } else { show("people"); window.scrollTo(0, 0); }
  });
  ["#s-q", "#s-org", "#s-state"].forEach((s) => $(s).addEventListener("input", () => {
    clearTimeout(timer); timer = setTimeout(render, 250);
  }));
  $("#s-csv").addEventListener("click", () => downloadCSV("grants.csv", views.search(50000)));
  document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 200); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
  $("#theme").value = document.documentElement.dataset.theme || "";
  $("#theme").addEventListener("change", (e) => {
    const t = e.target.value;
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    try { t ? localStorage.setItem("theme", t) : localStorage.removeItem("theme"); } catch (err) { /* private mode */ }
    render();  // charts read colours at draw time
  });

  $("#loading").remove();
  const fromHash = () => { const t = location.hash.slice(1); if (t !== current || !db) show(views[t] ? t : "overview"); };
  window.addEventListener("hashchange", fromHash);
  current = null;
  fromHash();
}

init().catch((e) => { $("#loading").textContent = `Could not load data: ${e.message}`; console.error(e); });
