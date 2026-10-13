// The SPRT view: where the test stands, how it got there and where it's heading. Numbers from /api/sprt, the
// pentanomial SPRT recomputed after every game pair, the latest totals OpenBench's when following a test there.
import { escapeHtml, formatCount } from "./format.js";

const SVG = "http://www.w3.org/2000/svg";

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

const signed = (v, digits = 2) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(digits);
const pct = (p) => (p == null ? "–" : p < 0.001 ? "<0.1%" : p > 0.999 ? ">99.9%" : `${(100 * p).toFixed(1)}%`);

function duration(hours) {
  if (hours == null || !isFinite(hours)) return "–";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

function when(hours) {
  if (hours == null || !isFinite(hours)) return "";
  const at = new Date(Date.now() + hours * 3600e3);
  return at.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// nice round axis ticks between lo and hi
function ticks(lo, hi, count = 5) {
  const span = hi - lo || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

// A line chart over games: series of [games, value], bands of [games, low, high], horizontal reference lines, a
// crosshair with a tooltip from describe(games).
function lineChart(host, { xMax, yMin, yMax, series = [], bands = [], refs = [], describe, height = 220 }) {
  host.innerHTML = "";
  const width = host.clientWidth || 640;
  const left = 46, right = 70, top = 10, bottom = 24;
  const x = (g) => left + (g / xMax) * (width - left - right);
  const y = (v) => top + (1 - (v - yMin) / (yMax - yMin)) * (height - top - bottom);
  const svg = el("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "sprt-svg" }, host);

  for (const v of ticks(yMin, yMax)) {
    el("line", { x1: left, x2: width - right, y1: y(v), y2: y(v), class: v === 0 ? "zero" : "grid" }, svg);
    el("text", { x: left - 6, y: y(v) + 3, class: "axis", "text-anchor": "end" }, svg).textContent = String(v);
  }
  for (const g of ticks(0, xMax, 6)) {
    el("text", { x: x(g), y: height - 6, class: "axis", "text-anchor": "middle" }, svg).textContent = formatCount(g);
  }
  for (const band of bands) {
    if (band.points.length < 2) continue;
    const upper = band.points.map(([g, , hi]) => `${x(g).toFixed(1)},${y(hi).toFixed(1)}`);
    const lower = band.points.map(([g, lo]) => `${x(g).toFixed(1)},${y(lo).toFixed(1)}`).reverse();
    el("path", { d: `M${upper.join("L")}L${lower.join("L")}Z`, class: `band ${band.cls}` }, svg);
  }
  // labels of lines close together are pushed apart, the higher one up
  const sorted = [...refs].sort((a, b) => b.value - a.value);
  let lastY = -Infinity;
  for (const ref of sorted) {
    el("line", { x1: left, x2: width - right, y1: y(ref.value), y2: y(ref.value), class: `ref ${ref.cls}` }, svg);
    const ly = Math.max(y(ref.value) + 3, lastY + 12);
    el("text", { x: width - right + 4, y: ly, class: "ref-label" }, svg).textContent = ref.label;
    lastY = ly;
  }
  for (const s of series) {
    if (s.points.length < 2) continue;
    const d = s.points.map(([g, v], i) => `${i ? "L" : "M"}${x(g).toFixed(1)},${y(v).toFixed(1)}`).join("");
    el("path", { d, class: `series ${s.cls}` }, svg);
    if (s.end) {
      const [g, v] = s.points[s.points.length - 1];
      el("circle", { cx: x(g), cy: y(v), r: 4, class: `end ${s.cls}` }, svg);
    }
  }
  const hover = el("line", { y1: top, y2: height - bottom, class: "hover", visibility: "hidden" }, svg);
  const tip = document.createElement("div");
  tip.className = "sprt-tip";
  tip.hidden = true;
  host.appendChild(tip);
  svg.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const g = Math.min(Math.max(((e.clientX - rect.left - left) / (width - left - right)) * xMax, 0), xMax);
    const text = describe(g);
    if (!text) { tip.hidden = true; hover.setAttribute("visibility", "hidden"); return; }
    hover.setAttribute("x1", x(g));
    hover.setAttribute("x2", x(g));
    hover.setAttribute("visibility", "visible");
    tip.innerHTML = text;
    tip.hidden = false;
    tip.style.left = `${Math.min(Math.max(x(g) - tip.offsetWidth / 2, 0), width - tip.offsetWidth)}px`;
  });
  svg.addEventListener("mouseleave", () => { tip.hidden = true; hover.setAttribute("visibility", "hidden"); });
}

// the history entry at or before a game count
function at(history, games) {
  let found = null;
  for (const h of history) { if (h.games > games) break; found = h; }
  return found;
}

export function renderSprt(root, r) {
  if (!r) {
    root.innerHTML = `<div class="empty">no SPRT: follow an OpenBench test (--openbench) or give its bounds (--sprt -3,1)
      with a PGN whose games come in pairs</div>`;
    return;
  }
  const p = r.projection;
  const cur = p?.current;
  const rate = r.rate;
  const left = (s) => (s?.pairs == null ? null : 2 * s.pairs);
  const eta = (s) => (left(s) != null && rate ? left(s) / rate : null);
  const elo = r.elo;
  const verdict = r.state === "running" ? "" : `<span class="verdict ${r.state}">${r.state === "passed" ? "passed, H1 accepted" : "failed, H0 accepted"}</span>`;

  root.innerHTML = `
    <div class="sprt-page-head">
      <h1>SPRT <span class="muted">[${r.elo0}, ${r.elo1}]</span> ${escapeHtml(r.dev)} <span class="vs">vs</span> ${escapeHtml(r.base ?? "?")}</h1>
      ${verdict}
      ${r.url ? `<a class="muted ext" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">OpenBench ↗</a>` : ""}
    </div>
    <div class="tiles">
      <div class="tile"><span class="label">LLR</span><b>${signed(r.llr)}</b><small>of ${signed(r.lower)} … ${signed(r.upper)}</small></div>
      <div class="tile"><span class="label">games</span><b>${formatCount(r.games)}</b><small>${rate ? `${Math.round(rate)} an hour` : "&nbsp;"}</small></div>
      <div class="tile"><span class="label">elo</span><b>${elo ? signed(elo[1]) : "–"}</b><small>${elo ? `95% ${signed(elo[0], 1)} … ${signed(elo[2], 1)}` : "&nbsp;"}</small></div>
      <div class="tile"><span class="label">chance it passes</span><b>${pct(cur?.pass)}</b><small>if the elo stays where it is</small></div>
      <div class="tile"><span class="label">games left, expected</span><b>${left(cur) == null ? "–" : `≈${formatCount(Math.round(left(cur)))}`}</b><small>${eta(cur) != null ? `${duration(eta(cur))}, ${when(eta(cur))}` : "&nbsp;"}</small></div>
    </div>

    <section class="panel">
      <h3>LLR over the games played</h3>
      <div class="chart" id="sp-llr"></div>
    </section>

    <section class="panel">
      <h3>where it's heading <span class="muted">expected path at the current drift, the band one standard deviation either side</span></h3>
      <div class="chart" id="sp-proj"></div>
      ${p ? `<table class="scen">
        <thead><tr><th>if dev's true elo is</th><th class="num">LLR drift / 1000 games</th><th class="num">chance it passes</th><th class="num">games left, expected</th><th class="num">time left</th></tr></thead>
        <tbody>${[["current", `${elo ? signed(elo[1], 1) : "?"} <span class="muted">(the estimate now)</span>`],
                  ["h1", `${signed(r.elo1, 1)} <span class="muted">(elo1)</span>`],
                  ["h0", `${signed(r.elo0, 1)} <span class="muted">(elo0)</span>`]].map(([k, label]) => `
          <tr><td>${label}</td><td class="num">${signed(p[k].drift * 500)}</td><td class="num">${pct(p[k].pass)}</td>
            <td class="num">${left(p[k]) == null ? "–" : `≈${formatCount(Math.round(left(p[k])))}`}</td>
            <td class="num">${duration(eta(p[k]))}</td></tr>`).join("")}</tbody>
      </table>
      <p class="note muted">Every game pair moves the LLR by the log-likelihood ratio of its outcome. With the outcome
        probabilities fixed that's a random walk; how long it takes to leave the bounds and through which one follows
        from its drift and spread (Wald). The estimate moves as the elo does, near zero elo it's long and uncertain.</p>` : ""}
    </section>

    <div class="sprt-row">
      <section class="panel">
        <h3>elo over the games played <span class="muted">with its 95% interval</span></h3>
        <div class="chart" id="sp-elo"></div>
      </section>
      <section class="panel">
        <h3>game pairs <span class="muted">dev's points from each pair</span></h3>
        <div id="sp-penta"></div>
      </section>
    </div>`;

  const history = r.history;
  const games = r.games;
  const describe = (g) => {
    const h = at(history, g);
    if (!h) return "";
    const time = h.time ? new Date(h.time * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
    return `<b>${formatCount(h.games)} games</b> LLR ${signed(h.llr)}${h.elo ? ` · elo ${signed(h.elo[1], 1)} [${signed(h.elo[0], 1)}, ${signed(h.elo[2], 1)}]` : ""}${time ? ` · ${time}` : ""}`;
  };
  const llrRefs = [
    { value: r.upper, label: "pass", cls: "pass" },
    { value: r.lower, label: "fail", cls: "fail" },
  ];
  const llrPoints = [[0, 0], ...history.map((h) => [h.games, h.llr])];
  const pad = (r.upper - r.lower) * 0.08;
  lineChart(root.querySelector("#sp-llr"), {
    xMax: Math.max(history.at(-1)?.games ?? 0, 10), yMin: r.lower - pad, yMax: r.upper + pad,
    series: [{ points: llrPoints, cls: "llr", end: true }], refs: llrRefs, describe,
  });

  // projection: the expected path drift·t from where it is now, ±1 sd·√t, out to the expected end
  const proj = root.querySelector("#sp-proj");
  if (cur && left(cur) != null) {
    const horizon = Math.min(Math.max(left(cur) * 1.15, games * 0.25), 400000);
    const xMax = games + horizon;
    const steps = 60;
    const path = [], cone = [];
    const clamp = (v) => Math.min(Math.max(v, r.lower), r.upper);
    for (let i = 0; i <= steps; i++) {
      const t = (horizon * i) / steps / 2;   // pairs ahead
      const mean = r.llr + cur.drift * t, spread = cur.sd * Math.sqrt(t);
      path.push([games + 2 * t, clamp(mean)]);
      cone.push([games + 2 * t, clamp(mean - spread), clamp(mean + spread)]);
    }
    lineChart(proj, {
      xMax, yMin: r.lower - pad, yMax: r.upper + pad,
      series: [{ points: llrPoints, cls: "llr" }, { points: path, cls: "proj" }],
      bands: [{ points: cone, cls: "cone" }],
      refs: llrRefs,
      describe: (g) => {
        if (g <= games) return describe(g);
        const t = (g - games) / 2;
        const mean = r.llr + cur.drift * t, spread = cur.sd * Math.sqrt(t);
        const hours = rate ? (g - games) / rate : null;
        return `<b>${formatCount(Math.round(g))} games</b> expected LLR ${signed(mean)} ± ${spread.toFixed(2)}${hours ? ` · in ${duration(hours)}` : ""}`;
      },
    });
    const svg = proj.querySelector("svg");
    const width = proj.clientWidth || 640;
    const xEnd = 46 + ((games + left(cur)) / xMax) * (width - 46 - 70);
    if (games + left(cur) <= xMax) {
      el("line", { x1: xEnd, x2: xEnd, y1: 10, y2: 220 - 24, class: "expected-end" }, svg);
      el("text", { x: xEnd - 4, y: 10 + ((r.upper + pad - r.upper) / (2 * pad + r.upper - r.lower)) * (220 - 34) + 16, class: "end-label", "text-anchor": "end" }, svg).textContent = `≈${formatCount(Math.round(games + left(cur)))} games`;
    }
  } else {
    proj.innerHTML = `<div class="empty">not enough pairs to project yet</div>`;
  }

  // the first pairs swing it by tens of elo, it's drawn from 100 games on
  const eloPoints = history.filter((h) => h.elo && h.games >= 100);
  const lo = Math.min(r.elo0 - 2, ...eloPoints.map((h) => h.elo[0]).filter((v) => v > -60), -5);
  const hi = Math.max(r.elo1 + 2, ...eloPoints.map((h) => h.elo[2]).filter((v) => v < 60), 5);
  lineChart(root.querySelector("#sp-elo"), {
    xMax: Math.max(history.at(-1)?.games ?? 0, 10), yMin: Math.max(lo, -60), yMax: Math.min(hi, 60),
    series: [{ points: eloPoints.map((h) => [h.games, h.elo[1]]), cls: "elo", end: true }],
    bands: [{ points: eloPoints.map((h) => [h.games, Math.max(h.elo[0], -60), Math.min(h.elo[2], 60)]), cls: "ci" }],
    refs: [{ value: r.elo1, label: `elo1 ${signed(r.elo1, 0)}`, cls: "bound" }, { value: r.elo0, label: `elo0 ${signed(r.elo0, 0)}`, cls: "bound" }],
    describe,
  });

  // pentanomial: bars, the count & share on each
  const penta = r.penta;
  const total = penta.reduce((a, b) => a + b, 0) || 1;
  const most = Math.max(...penta, 1);
  const names = ["0", "½", "1", "1½", "2"];
  const hints = ["lost both", "a loss & a draw", "two draws or a win & a loss", "a win & a draw", "won both"];
  root.querySelector("#sp-penta").innerHTML = `<div class="penta">${penta.map((n, i) => `
    <div class="pbar" title="${hints[i]}: ${n} pairs, ${(100 * n / total).toFixed(1)}%">
      <span class="pcount">${n}</span>
      <i style="height:${(100 * n / most).toFixed(1)}%"></i>
      <span class="pname">${names[i]}</span>
    </div>`).join("")}</div>
    <div class="muted penta-note">${total} pairs · ${r.source === "openbench" ? "OpenBench's count, every worker" : "the pairs in the PGN"}</div>`;
}
