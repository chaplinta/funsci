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

let db;
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
  };
}

// WHERE fragment over grants aliased g. opts.basic overrides the checkbox.
function where(extra = [], opts = {}) {
  const f = filters();
  const parts = ["g.round_year BETWEEN ? AND ?"], p = [f.from, f.to];
  parts.push(`g.source IN (${f.sources.map(() => "?").join(",") || "''"})`); p.push(...f.sources);
  if (f.field) { parts.push("g.field_group = ?"); p.push(f.field); }
  if (opts.basic ?? f.basic) parts.push("g.basic_science = 1");
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

function table(sel, rows, cols) {
  if (!rows.length) return empty(sel);
  const head = cols.map((c) => `<th class="${c.n ? "n" : ""}">${esc(c.label)}</th>`).join("");
  const body = rows.map((r) => "<tr>" + cols.map((c) => {
    const v = c.f ? c.f(r) : esc(r[c.key]);
    return `<td class="${c.n ? "n" : ""}">${v}</td>`;
  }).join("") + "</tr>").join("");
  $(sel).innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
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
      ["WA share", tot.s ? fmtPct(tot.wa / tot.s) : "–", `WA population share ${fmtPct(POP.WA / POP_TOTAL)}`],
    ]);

    const byYear = q(`SELECT round_year year, source, SUM(amount_aud)/1e6 m, COUNT(*) n
                      FROM grants g WHERE ${w} GROUP BY 1,2`, p);
    if (!byYear.length) empty("#ov-year");
    else plotInto("#ov-year", {
      height: 320, x: yearX(), y: { label: "A$m", grid: true },
      color: colorScale(),
      marks: [Plot.barY(byYear, { x: "year", y: "m", fill: "source", inset: 1, rx: 2, tip: { format: { m: ",.1f" } } }),
        Plot.ruleY([0])],
    });

    const byState = q(`SELECT state, SUM(amount_aud) s, COUNT(*) n FROM grants g
                       WHERE ${w} AND state IS NOT NULL GROUP BY 1`, p);
    const total = d3.sum(byState, (d) => d.s);
    const rows = STATES.map((st) => {
      const r = byState.find((d) => d.state === st) || { s: 0, n: 0 };
      return { state: st, share: total ? r.s / total : 0, pop: POP[st] / POP_TOTAL, s: r.s, n: r.n,
        percap: r.s / POP[st] };
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
        { label: "Share of population", n: 1, f: (r) => fmtPct(r.pop) },
        { label: "A$ per resident", n: 1, f: (r) => d3.format(",.0f")(r.percap) },
      ]);
    }

    const share = q(`SELECT round_year year, source, SUM(CASE WHEN state='WA' THEN amount_aud ELSE 0 END)/SUM(amount_aud) share
                     FROM grants g WHERE ${w} GROUP BY 1,2 HAVING SUM(amount_aud) > 0`, p);
    if (!share.length) empty("#ov-washare");
    else plotInto("#ov-washare", {
      height: 280, x: { label: null, tickFormat: "d" }, y: { label: "WA share", tickFormat: "%", grid: true, zero: true },
      color: colorScale(),
      marks: [
        Plot.ruleY([POP.WA / POP_TOTAL], { stroke: css("--ink-3"), strokeDasharray: "4 4" }),
        Plot.lineY(share, { x: "year", y: "share", stroke: "source", strokeWidth: 2 }),
        Plot.dot(share, { x: "year", y: "share", fill: "source", r: 3 }),
        Plot.tip(share, Plot.pointer({ x: "year", y: "share", channels: { source: "source" }, format: { y: ".1%" } })),
      ],
    });
  },

  wa() {
    const sci = ["COALESCE(g.field_group, '') <> 'Humanities & social sciences'"];
    const [w, p] = where([["g.state = ?", "WA"], sci], { basic: true });
    const [wn, pn] = where([sci], { basic: true });
    const t = q(`SELECT COUNT(*) n, SUM(amount_aud) s FROM grants g WHERE ${w}`, p)[0];
    const nat = q(`SELECT SUM(amount_aud) s FROM grants g WHERE ${wn}`, pn)[0].s || 0;
    tiles("#wa-tiles", [
      ["WA basic science grants", fmtInt(t.n), yearsLabel()],
      ["Amount", fmtB(t.s || 0), "ARC Discovery + NHMRC Basic Science"],
      ["Share of national basic science", nat ? fmtPct((t.s || 0) / nat) : "–", `population share ${fmtPct(POP.WA / POP_TOTAL)}`],
      ["Per WA resident", d3.format("$,.0f")((t.s || 0) / POP.WA), "over selected years"],
    ]);

    const byYear = q(`SELECT round_year year, source, SUM(amount_aud)/1e6 m FROM grants g WHERE ${w} GROUP BY 1,2`, p);
    if (!byYear.length) empty("#wa-year");
    else plotInto("#wa-year", {
      height: 300, x: yearX(), y: { label: "A$m", grid: true },
      color: colorScale(),
      marks: [Plot.barY(byYear, { x: "year", y: "m", fill: "source", inset: 1, rx: 2, tip: { format: { m: ",.1f" } } }),
        Plot.ruleY([0])],
    });

    const st = q(`SELECT state, SUM(amount_aud) s FROM grants g WHERE ${wn} AND state IS NOT NULL GROUP BY 1`, pn)
      .filter((d) => POP[d.state]).map((d) => ({ ...d, percap: d.s / POP[d.state] }));
    if (!st.length) empty("#wa-percap");
    else plotInto("#wa-percap", {
      height: 260, marginLeft: 44, x: { label: "A$ per resident", grid: true },
      y: { label: null, domain: d3.sort(st, (d) => -d.percap).map((d) => d.state) },
      marks: [Plot.barX(st, { y: "state", x: "percap", rx: 2,
        fill: (d) => d.state === "WA" ? css("--accent") : css("--muted-mark"), tip: { format: { percap: ",.0f", fill: false } } }),
      Plot.ruleX([0])],
    });

    const inst = q(`SELECT o.name org, g.source, SUM(amount_aud)/1e6 m FROM grants g JOIN organisations o ON o.id=g.org_id
                    WHERE ${w} GROUP BY 1,2`, p);
    if (!inst.length) empty("#wa-inst");
    else {
      const order = d3.groupSort(inst, (v) => -d3.sum(v, (d) => d.m), (d) => d.org).slice(0, 15);
      const data = inst.filter((d) => order.includes(d.org));
      plotInto("#wa-inst", {
        height: 40 + order.length * 26, ...catY(order, 260), x: { label: "A$m", grid: true },
        color: colorScale(),
        marks: [Plot.barX(data, { y: "org", x: "m", fill: "source", rx: 2, inset: 1, tip: { format: { m: ",.1f" } } }), Plot.ruleX([0])],
      });
    }

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
      marks: [Plot.barY(byYear, { x: "year", y: "m", fill: "source", inset: 1, rx: 2, tip: { format: { m: ",.1f" } } }), Plot.ruleY([0])],
    });

    const b = q(`SELECT year, CASE WHEN program IN ('RTP','RSP') THEN program ELSE 'Earlier schemes' END program,
                 SUM(amount_aud)/1e6 m FROM block_grants WHERE org_id=? AND year BETWEEN ? AND ? GROUP BY 1,2`, [id, f.from, f.to]);
    if (!b.length) empty("#inst-block", "No block grant data for this organisation.");
    else plotInto("#inst-block", {
      height: 240, x: yearX(), y: { label: "A$m", grid: true },
      color: { domain: ["RTP", "RSP", "Earlier schemes"], range: [css("--s1"), css("--s2"), css("--s3")], legend: true },
      marks: [Plot.barY(b, { x: "year", y: "m", fill: "program", inset: 1, rx: 2, tip: { format: { m: ",.1f" } } }), Plot.ruleY([0])],
    });

    const h = q(`SELECT year, category, amount_aud/1e6 m FROM research_income
                 WHERE org_id=? AND category<>'Total' AND year BETWEEN ? AND ?`, [id, f.from, f.to]);
    const cats = ["Cat 1", "Cat 2", "Cat 3", "Cat 4"];
    if (!h.length) empty("#inst-herdc", "No HERDC data for this organisation.");
    else plotInto("#inst-herdc", {
      height: 240, x: yearX(), y: { label: "A$m", grid: true },
      color: { domain: cats, range: ["--s1", "--s2", "--s3", "--s4"].map(css), legend: true },
      marks: [Plot.barY(h, { x: "year", y: "m", fill: "category", inset: 1, rx: 2, tip: { format: { m: ",.1f" } } }), Plot.ruleY([0])],
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
                    COALESCE(o.name, g.org_raw) org, g.state, g.amount_aud, g.field_group field, g.basic_science basic
                    ${base} ORDER BY g.amount_aud DESC LIMIT ${limit}`, p);
    if (limit > 500) return rows;
    $("#s-count").textContent = `${fmtInt(cnt.n)} grants, ${fmtB(cnt.s || 0)}. ` +
      (cnt.n > 500 ? "Showing the 500 largest; the CSV includes up to 50,000." : "");
    table("#s-table", rows, [
      { key: "id", label: "ID" }, { key: "year", label: "Year" }, { key: "scheme", label: "Scheme" },
      { key: "title", label: "Title" }, { key: "lead", label: "Lead investigator" }, { key: "org", label: "Organisation" },
      { key: "state", label: "State" }, { label: "Amount", n: 1, f: (r) => fmtM(r.amount_aud) },
      { label: "Basic", f: (r) => r.basic ? "yes" : "" },
    ]);
  },

  other() {
    const ph = q(`SELECT p.donor, COALESCE(o.name, p.recipient_raw) recipient, p.year, p.amount_aud, p.purpose, p.source_url
                  FROM philanthropy p LEFT JOIN organisations o ON o.id=p.org_id ORDER BY p.year DESC, p.amount_aud DESC`);
    const byYear = d3.rollups(ph.filter((d) => d.year), (v) => d3.sum(v, (d) => d.amount_aud) / 1e6, (d) => d.year)
      .map(([year, m]) => ({ year, m }));
    if (!byYear.length) empty("#ph-year", "No philanthropy records loaded.");
    else plotInto("#ph-year", {
      height: 240, x: yearX(), y: { label: "A$m", grid: true },
      marks: [Plot.barY(byYear, { x: "year", y: "m", fill: css("--s5"), rx: 2, tip: { format: { m: ",.1f" } } }), Plot.ruleY([0])],
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

  sql() {},

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

/* ---------- wiring ---------- */
let current = "overview";
const FILTER_TABS = new Set(["overview", "wa", "inst", "search"]);

function show(tab) {
  current = tab;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  document.querySelectorAll("[data-panel]").forEach((s) => { s.hidden = s.dataset.panel !== tab; });
  $("#filters").hidden = !FILTER_TABS.has(tab);
  $("#f-basic").parentElement.hidden = tab === "wa";
  history.replaceState(null, "", `#${tab}`);
  render();
}

function render() {
  try { views[current](); } catch (e) { console.error(e); }
}

function runSQL(forCsv) {
  try {
    const res = db.exec($("#sql-q").value);
    const last = res[res.length - 1];
    if (!last) { $("#sql-msg").textContent = "No rows."; $("#sql-out").replaceChildren(); return []; }
    const rows = last.values.map((v) => Object.fromEntries(last.columns.map((c, i) => [c, v[i]])));
    if (forCsv) return rows;
    $("#sql-msg").textContent = `${fmtInt(rows.length)} rows${rows.length > 1000 ? " (showing 1,000)" : ""}.`;
    table("#sql-out", rows.slice(0, 1000), last.columns.map((c) => ({ key: c, label: c })));
    return rows;
  } catch (e) {
    $("#sql-msg").textContent = e.message;
    return [];
  }
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
  STATES.forEach((s) => $("#s-state").add(new Option(s, s)));

  const orgs = q(`SELECT o.id, o.name, o.state, COALESCE(SUM(g.amount_aud),0) s FROM organisations o
                  LEFT JOIN grants g ON g.org_id=o.id GROUP BY o.id
                  HAVING s > 0 OR o.id IN (SELECT org_id FROM block_grants) OR o.id IN (SELECT org_id FROM philanthropy)
                  ORDER BY (o.state='WA') DESC, s DESC`);
  for (const o of orgs) $("#inst-pick").add(new Option(`${o.name}${o.state ? ` (${o.state})` : ""}`, o.id));

  const meta = await fetch("data/meta.json").then((r) => r.ok ? r.json() : {}).catch(() => ({}));
  $("#ab-built").textContent = meta.built ? new Date(meta.built).toLocaleString("en-AU") : "unknown";

  document.querySelectorAll("#filters select, #filters input").forEach((el) => el.addEventListener("change", render));
  $("#inst-pick").addEventListener("change", render);
  let timer;
  ["#s-q", "#s-org", "#s-state"].forEach((s) => $(s).addEventListener("input", () => {
    clearTimeout(timer); timer = setTimeout(render, 250);
  }));
  $("#s-csv").addEventListener("click", () => downloadCSV("grants.csv", views.search(50000)));
  $("#sql-run").addEventListener("click", () => runSQL());
  $("#sql-csv").addEventListener("click", () => downloadCSV("query.csv", runSQL(true)));
  document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 200); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);

  $("#loading").remove();
  runSQL();
  const fromHash = () => { const t = location.hash.slice(1); if (t !== current || !db) show(views[t] ? t : "overview"); };
  window.addEventListener("hashchange", fromHash);
  current = null;
  fromHash();
}

init().catch((e) => { $("#loading").textContent = `Could not load data: ${e.message}`; console.error(e); });
