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
    topic: $("#f-topic").value, kw: $("#f-kw").checked,
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

const orgList = (s) => {
  const xs = (s || "").split(",").filter(Boolean);
  return esc(xs.slice(0, 3).join("; ")) + (xs.length > 3 ? ` <span class="note">+${xs.length - 3} more</span>` : "");
};
const who = (key, name) => key ? `<a class="who" data-key="${esc(key)}">${esc(name)}</a>` : esc(name);

// One row per (grant, person); role filter optional. Avoids double counting lead + CI rows.
const peopleSQL = (role) => `(SELECT grant_id, name_key, MAX(name) name, MIN(role) role FROM investigators
  ${role ? "WHERE role = 'lead'" : ""} GROUP BY grant_id, name_key)`;

function stackedYears(sel, rows, height = 280) {
  if (!rows.length) return empty(sel);
  plotInto(sel, {
    height, x: yearX(), y: { label: "A$m", grid: true }, color: colorScale(),
    marks: [Plot.barY(rows, { x: "year", y: "m", fill: "source", inset: 1, rx: 2, tip: { format: { m: ",.1f" } } }), Plot.ruleY([0])],
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

  bio() {
    const topic = $("#bio-topic").value, st = $("#bio-state").value, ms = methodSQL();
    const [w, p] = where([], { topic: null });
    const [wt, pt] = where([topicClause(topic)], { topic: null });
    $("#bio-share-cap").textContent = `${st} share of national funding in each topic (bars) against ${st} share of population (dashed line)`;
    $("#bio-trend-cap").textContent = `${topic} in ${st}, by year and funder (A$m)`;
    $("#bio-inst-cap").textContent = `Top ${st} institutions in ${topic} (A$m, selected years)`;
    $("#bio-people-cap").textContent = `Top ${st} researchers in ${topic} (selected years)`;

    const nat = q(`SELECT COUNT(*) n, SUM(amount_aud) s, SUM(CASE WHEN state=? THEN amount_aud END) st,
                   SUM(CASE WHEN state=? THEN 1 ELSE 0 END) stn FROM grants g WHERE ${wt}`, [st, st, ...pt])[0];
    const byState = q(`SELECT state, SUM(amount_aud) s FROM grants g WHERE ${wt} AND state IS NOT NULL GROUP BY 1`, pt)
      .filter((d) => POP[d.state]).map((d) => ({ ...d, percap: d.s / POP[d.state] }));
    const rank = d3.sort(byState, (d) => -d.percap).findIndex((d) => d.state === st) + 1;
    tiles("#bio-tiles", [
      [`${topic} grants in ${st}`, fmtInt(nat.stn || 0), yearsLabel()],
      ["Amount", fmtB(nat.st || 0), `of ${fmtB(nat.s || 0)} nationally`],
      [`${st} share`, nat.s ? fmtPct((nat.st || 0) / nat.s) : "–", `population share ${fmtPct(POP[st] / POP_TOTAL)}`],
      ["Per resident", d3.format("$,.2f")((nat.st || 0) / POP[st]), rank ? `rank ${rank} of ${byState.length} states` : ""],
    ]);

    const heat = q(`SELECT t.topic, g.round_year year, SUM(g.amount_aud)/1e6 m, COUNT(*) n FROM grants g
                    JOIN grant_topics t ON t.grant_id = g.id${ms} WHERE ${w} GROUP BY 1, 2`, p);
    if (!heat.length) empty("#bio-heat");
    else plotInto("#bio-heat", {
      height: 60 + TOPICS.length * 28, ...catY(TOPICS, 250), x: yearX({ axis: "top" }),
      color: { type: "sqrt", scheme: "blues", legend: true, label: "A$m" },
      marks: [Plot.cell(heat, { x: "year", y: "topic", fill: "m", inset: 0.5, tip: { format: { m: ",.1f", n: true } },
        channels: { n: { value: "n", label: "grants" } } })],
    });

    const share = q(`SELECT t.topic, SUM(g.amount_aud) s, SUM(CASE WHEN g.state=? THEN g.amount_aud ELSE 0 END) st
                     FROM grants g JOIN grant_topics t ON t.grant_id = g.id${ms} WHERE ${w} GROUP BY 1`, [st, ...p])
      .map((d) => ({ ...d, share: d.s ? d.st / d.s : 0 }));
    if (!share.length) empty("#bio-share");
    else plotInto("#bio-share", {
      height: 60 + TOPICS.length * 26, ...catY(TOPICS, 250), x: { label: `${st} share of national`, tickFormat: "%", grid: true },
      marks: [
        Plot.barX(share, { y: "topic", x: "share", rx: 2, tip: { format: { share: ".1%", fill: false } },
          fill: (d) => d.topic === topic ? css("--accent") : css("--muted-mark") }),
        Plot.ruleX([POP[st] / POP_TOTAL], { stroke: css("--ink"), strokeDasharray: "4 3" }),
        Plot.ruleX([0]),
      ],
    });

    stackedYears("#bio-trend", q(`SELECT round_year year, source, SUM(amount_aud)/1e6 m FROM grants g
                                  WHERE ${wt} AND g.state = ? GROUP BY 1, 2`, [...pt, st]));

    if (!byState.length) empty("#bio-percap");
    else plotInto("#bio-percap", {
      height: 260, marginLeft: 44, x: { label: "A$ per resident", grid: true },
      y: { label: null, domain: d3.sort(byState, (d) => -d.percap).map((d) => d.state) },
      marks: [Plot.barX(byState, { y: "state", x: "percap", rx: 2, tip: { format: { percap: ",.2f", fill: false } },
        fill: (d) => d.state === st ? css("--accent") : css("--muted-mark") }), Plot.ruleX([0])],
    });

    stackedOrgs("#bio-inst", q(`SELECT o.name org, g.source, SUM(amount_aud)/1e6 m FROM grants g
                                JOIN organisations o ON o.id = g.org_id WHERE ${wt} AND g.state = ? GROUP BY 1, 2`, [...pt, st]));

    table("#bio-people", q(`SELECT i.name_key k, MAX(i.name) name, COUNT(*) n, SUM(g.amount_aud) s,
                            MIN(g.round_year) y0, MAX(g.round_year) y1, GROUP_CONCAT(DISTINCT COALESCE(o.name, g.org_raw)) orgs
                            FROM ${peopleSQL()} i JOIN grants g ON g.id = i.grant_id LEFT JOIN organisations o ON o.id = g.org_id
                            WHERE ${wt} AND g.state = ? GROUP BY 1 ORDER BY s DESC LIMIT 25`, [...pt, st]), [
      { label: "Researcher", f: (r) => who(r.k, r.name) }, { label: "Grants", n: 1, f: (r) => fmtInt(r.n) },
      { label: "Total", n: 1, f: (r) => fmtM(r.s) }, { label: "Years", n: 1, f: (r) => `${r.y0}–${r.y1}` },
      { label: "Organisations", f: (r) => orgList(r.orgs) },
    ]);

    table("#bio-grants", q(`SELECT g.round_year year, g.source, g.scheme, g.title, g.lead_investigator lead,
                            (SELECT name_key FROM investigators WHERE grant_id = g.id AND role = 'lead') k,
                            COALESCE(o.name, g.org_raw) org, g.amount_aud
                            FROM grants g LEFT JOIN organisations o ON o.id = g.org_id
                            WHERE ${wt} AND g.state = ? ORDER BY g.amount_aud DESC LIMIT 25`, [...pt, st]), [
      { key: "year", label: "Year" }, { key: "scheme", label: "Scheme" }, { key: "title", label: "Title" },
      { label: "Lead", f: (r) => who(r.k, r.lead) }, { key: "org", label: "Organisation" },
      { label: "Amount", n: 1, f: (r) => fmtM(r.amount_aud) },
    ]);
  },

  people() {
    $("#p-profile").hidden = !personKey;
    $("#p-board-card").hidden = !!personKey;
    if (personKey) return views.profile(personKey);
    const extra = [];
    const st = $("#p-state").value, role = $("#p-role").value, s = $("#p-q").value.trim();
    if (st) extra.push(["g.state = ?", st]);
    if (s) extra.push(["(i.name LIKE ? OR i.name_key LIKE ?)", `%${s}%`, `%${s.toLowerCase()}%`]);
    const [w, p] = where(extra);
    const f = filters();
    $("#p-board-cap").textContent = `Most funded researchers${st ? ` on ${st} grants` : ""}${f.topic ? ` in ${f.topic}` : ""}, ${yearsLabel()}` +
      `${role ? " (lead only)" : ""}. Click a name for their profile.`;
    table("#p-board", q(`SELECT i.name_key k, MAX(i.name) name, COUNT(*) n, SUM(g.amount_aud) s,
                         SUM(CASE WHEN i.role = 'lead' THEN 1 ELSE 0 END) led, MIN(g.round_year) y0, MAX(g.round_year) y1,
                         GROUP_CONCAT(DISTINCT g.source) funders, GROUP_CONCAT(DISTINCT COALESCE(o.name, g.org_raw)) orgs
                         FROM ${peopleSQL(role)} i JOIN grants g ON g.id = i.grant_id LEFT JOIN organisations o ON o.id = g.org_id
                         WHERE ${w} GROUP BY 1 ORDER BY s DESC LIMIT 100`, p), [
      { label: "Researcher", f: (r) => who(r.k, r.name) }, { label: "Grants", n: 1, f: (r) => fmtInt(r.n) },
      { label: "As lead", n: 1, f: (r) => fmtInt(r.led) }, { label: "Total", n: 1, f: (r) => fmtM(r.s) },
      { label: "Years", n: 1, f: (r) => `${r.y0}–${r.y1}` }, { label: "Funders", f: (r) => esc((r.funders || "").split(",").join(", ")) }, { label: "Organisations", f: (r) => orgList(r.orgs) },
    ]);
  },

  profile(key, csv) {
    const [w, p] = where([["i.name_key = ?", key]]);
    const grants = q(`SELECT g.id, g.round_year year, g.source, g.scheme, g.title, i.role, g.lead_investigator lead,
                      COALESCE(o.name, g.org_raw) org, g.state, g.amount_aud, g.basic_science basic
                      FROM ${peopleSQL()} i JOIN grants g ON g.id = i.grant_id LEFT JOIN organisations o ON o.id = g.org_id
                      WHERE ${w} ORDER BY g.round_year DESC, g.amount_aud DESC`, p);
    if (csv) return grants;
    const name = q("SELECT name, COUNT(*) c FROM investigators WHERE name_key = ? GROUP BY 1 ORDER BY c DESC LIMIT 1", [key])[0];
    $("#p-name").textContent = name ? name.name : key;
    const orgs = [...new Set(grants.map((g) => g.org).filter(Boolean))];
    const yrs = grants.map((g) => g.year).filter(Boolean);
    tiles("#p-tiles", [
      ["Grants", fmtInt(grants.length), `${grants.filter((g) => g.role === "lead").length} as lead`],
      ["Total awarded", fmtB(d3.sum(grants, (g) => g.amount_aud)), "full grant value, shared with co-investigators"],
      ["Active", yrs.length ? `${d3.min(yrs)}–${d3.max(yrs)}` : "–", "within selected years and funders"],
      ["Organisations", fmtInt(orgs.length), orgs.slice(0, 2).join("; ") + (orgs.length > 2 ? "…" : "")],
    ]);
    stackedYears("#p-year", d3.rollups(grants, (v) => d3.sum(v, (g) => g.amount_aud) / 1e6, (g) => g.year, (g) => g.source)
      .flatMap(([year, xs]) => xs.map(([source, m]) => ({ year, source, m }))), 240);

    const ms = methodSQL();
    const tops = q(`SELECT t.topic, SUM(g.amount_aud)/1e6 m, COUNT(*) n FROM ${peopleSQL()} i JOIN grants g ON g.id = i.grant_id
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
      { label: "Amount", n: 1, f: (r) => fmtM(r.amount_aud) }, { label: "Basic", f: (r) => r.basic ? "yes" : "" },
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
const FILTER_TABS = new Set(["overview", "wa", "bio", "people", "inst", "search"]);

function show(tab) {
  current = tab;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  document.querySelectorAll("[data-panel]").forEach((s) => { s.hidden = s.dataset.panel !== tab; });
  $("#filters").hidden = !FILTER_TABS.has(tab);
  $("#f-basic").parentElement.hidden = tab === "wa";
  $("#f-topic-wrap").hidden = tab === "bio";
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
  STATES.forEach((s) => {
    $("#s-state").add(new Option(s, s)); $("#bio-state").add(new Option(s, s)); $("#p-state").add(new Option(s, s));
  });
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
  ["#bio-topic", "#bio-state", "#p-state", "#p-role"].forEach((s) => $(s).addEventListener("change", render));
  $("#p-q").addEventListener("input", () => { personKey = null; clearTimeout(timer); timer = setTimeout(render, 250); });
  $("#p-back").addEventListener("click", () => { personKey = null; render(); });
  $("#p-csv").addEventListener("click", () => personKey && downloadCSV(`${personKey.replace("|", "_")}.csv`, views.profile(personKey, true)));
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a.who");
    if (!a) return;
    e.preventDefault();
    personKey = a.dataset.key;
    if (current === "people") { render(); window.scrollTo(0, 0); } else { show("people"); window.scrollTo(0, 0); }
  });
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
