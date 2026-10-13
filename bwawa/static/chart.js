// The eval graph of a game: white's view over the plies, a line per engine (its own eval of the moves it played) and
// one for the reference engine when there is one, book moves shaded, hover for the move, click to show it.
import { escapeHtml, formatEval } from "./format.js";

const SVG = "http://www.w3.org/2000/svg";

// centipawns to -1..1, the winning chances curve lichess uses, so +0.3 and +8 both fit on one axis.
function squash(cp, mate) {
  if (mate != null) return mate > 0 ? 1 : -1;
  if (cp == null) return null;
  return 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;
}

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function remembered(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function remember(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window, blocked storage */ }
}

const SERIES = ["w", "b", "ref"];

export class EvalGraph {
  constructor(parent, onSelect) {
    this.wrap = document.createElement("div");
    this.wrap.className = "graph";
    this.legend = document.createElement("div");
    this.legend.className = "legend";
    this.tip = document.createElement("div");
    this.tip.className = "tip";
    this.tip.hidden = true;
    parent.appendChild(this.wrap);
    this.wrap.append(this.legend, this.tip);
    this.onSelect = onSelect;
    this.data = null;
    // which lines are shown and whether they share one plot or get one each, kept across games & reloads
    this.shown = { w: true, b: true, ref: true, ...remembered("bwawa.graph.shown", {}) };
    this.mode = remembered("bwawa.graph.mode", "overlay");
    this.legend.addEventListener("click", (e) => {
      const button = e.target.closest("button");
      if (!button) return;
      if (button.dataset.series) {
        this.shown[button.dataset.series] = !this.shown[button.dataset.series];
        remember("bwawa.graph.shown", this.shown);
      } else if (button.dataset.mode) {
        this.mode = button.dataset.mode;
        remember("bwawa.graph.mode", this.mode);
      }
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(this.wrap);
  }

  // moves: the game's move records, selected: ply shown on the board, live: {cp, mate, white} of the search in
  // progress, ref: the reference engine's {cp, mate} per ply from 0 (null where not evaluated yet), names: of the
  // white & black engines and the reference engine
  set(moves, selected, live, { label = (ply) => `${Math.ceil(ply / 2)}${ply % 2 ? "." : "…"}`, ref = null, names = {} } = {}) {
    this.data = { moves, selected, live, label, ref, names };
    this.draw();
  }

  draw() {
    if (!this.data) return;
    const { moves, selected, live, ref, names } = this.data;

    // the lines: each engine's eval of the moves it played (the book left out), and the reference engine's of every
    // position it got to
    const engine = (white) => moves.filter((m) => m.white === white && !m.book).map((m) => [m.ply, squash(m.cp, m.mate)]);
    const points = { w: engine(true), b: engine(false), ref: ref ? ref.map((e, ply) => [ply, e ? squash(e.cp, e.mate) : null]) : [] };
    const available = SERIES.filter((key) => key !== "ref" || points.ref.some(([, v]) => v != null));
    const visible = available.filter((key) => this.shown[key]);
    const name = { w: names.white ?? "white", b: names.black ?? "black", ref: names.ref ?? "reference" };
    this.renderLegend(available, name);

    // one plot for all lines, or one each stacked over a shared move axis
    const stacked = this.mode === "stack" && visible.length > 1;
    const panels = stacked ? visible.map((key) => [key]) : [visible];
    const plotHeight = stacked ? 76 : 124, gap = 8;
    const width = this.wrap.clientWidth || 600;
    const left = 30, right = 8, top = 8, bottom = 18;
    const height = top + panels.length * plotHeight + (panels.length - 1) * gap + bottom;
    const plies = Math.max(moves.length + (live ? 1 : 0), 20);
    const x = (ply) => left + (ply / plies) * (width - left - right);
    Object.assign(this, { x, plies, left, right, width });

    this.wrap.querySelector("svg")?.remove();
    const svg = el("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "graph-svg" });
    this.wrap.insertBefore(svg, this.tip);
    const defs = el("defs", {}, svg);
    const hatch = el("pattern", { id: "hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse",
                                  patternTransform: "rotate(45)" }, defs);
    el("line", { x1: 0, y1: 0, x2: 0, y2: 6, class: "hatch-line" }, hatch);

    let book = 0;
    while (book < moves.length && moves[book].book) book++;
    // both engines' evals in move order, what the area is shaded by when a plot has both engines
    const combined = moves.filter((m) => !m.book).map((m) => [m.ply, squash(m.cp, m.mate)]);

    panels.forEach((keys, index) => {
      const panelTop = top + index * (plotHeight + gap);
      const y = (v) => panelTop + (1 - (v + 1) / 2) * plotHeight;
      const zero = y(0);
      el("clipPath", { id: `above-${index}` }, defs).appendChild(el("rect", { x: 0, y: panelTop, width, height: zero - panelTop }));
      el("clipPath", { id: `below-${index}` }, defs).appendChild(el("rect", { x: 0, y: zero, width, height: panelTop + plotHeight - zero }));

      // book moves, the opening before either engine searched
      if (book > 0) el("rect", { x: x(0), y: panelTop, width: x(book) - x(0), height: plotHeight, fill: "url(#hatch)" }, svg);
      // grid: 0, ±1, ±3 pawns, a short plot labels fewer
      for (const pawns of [-3, -1, 0, 1, 3]) {
        const gy = y(squash(pawns * 100, null));
        el("line", { x1: left, x2: width - right, y1: gy, y2: gy, class: pawns === 0 ? "zero" : "grid" }, svg);
        if (stacked && Math.abs(pawns) === 1) continue;
        el("text", { x: left - 4, y: gy + 3, class: "axis", "text-anchor": "end" }, svg)
          .textContent = pawns > 0 ? `+${pawns}` : `${pawns}`;
      }

      // [ply, value] points to a path drawn straight across the plies without a value: the reference engine skips
      // positions of a live game when the moves come faster than it evaluates them
      const path = (series) => {
        const seg = series.filter(([, v]) => v != null).map(([ply, v]) => [x(ply), y(v)]);
        if (!seg.length) return null;
        return { line: seg.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(""),
                 first: seg[0][0], last: seg[seg.length - 1][0] };
      };
      const engines = keys.includes("w") && keys.includes("b");
      // shaded by both engines' evals when the plot has them, else by its one engine, else by the reference engine
      const shadeKey = keys.find((k) => k !== "ref") ?? keys[0];
      const shade = path(engines ? combined : shadeKey ? points[shadeKey] : []);
      if (shade) {
        const area = `${shade.line}L${shade.last.toFixed(1)},${zero}L${shade.first.toFixed(1)},${zero}Z`;
        el("path", { d: area, class: "area-white", "clip-path": `url(#above-${index})` }, svg);
        el("path", { d: area, class: "area-black", "clip-path": `url(#below-${index})` }, svg);
      }
      // the reference engine under the engines' lines
      for (const key of ["ref", "w", "b"].filter((k) => keys.includes(k))) {
        const line = path(points[key]);
        if (line) el("path", { d: line.line, class: `eval-line ${key}` }, svg);
      }
      if (stacked) el("text", { x: left + 6, y: panelTop + 11, class: `panel-name ${keys[0]}` }, svg).textContent = name[keys[0]];

      // the search in progress, from the searching engine's last eval to where it stands now
      const liveSide = live?.white ? "w" : "b";
      const liveValue = live ? squash(live.cp, live.mate) : null;
      if (liveValue != null && keys.includes(liveSide)) {
        const last = [...points[liveSide]].reverse().find(([, v]) => v != null);
        if (last) el("line", { x1: x(last[0]), y1: y(last[1]), x2: x(moves.length + 1), y2: y(liveValue), class: `live-line ${liveSide}` }, svg);
        el("circle", { cx: x(moves.length + 1), cy: y(liveValue), r: 4, class: `live-dot ${liveSide}` }, svg);
      }
      // the ply on the board: its dot on the reference eval when the plot has it, else on the mover's eval
      const move = selected > 0 ? moves[selected - 1] : null;
      if (move) {
        const mover = move.white ? "w" : "b";
        let v = keys.includes("ref") ? points.ref[selected]?.[1] : null;
        if (v == null && keys.includes(mover)) v = squash(move.cp, move.mate);
        if (v != null) el("circle", { cx: x(selected), cy: y(v), r: 4, class: "selected-dot" }, svg);
      }
    });

    const plotBottom = height - bottom;
    if (book > 0) {
      el("text", { x: x(book / 2), y: height - 5, class: "axis book-label", "text-anchor": "middle" }, svg).textContent = "book";
    }
    // move numbers along the bottom
    const step = plies > 160 ? 40 : plies > 80 ? 20 : 10;
    for (let ply = step; ply < plies; ply += step) {
      el("text", { x: x(ply), y: height - 5, class: "axis", "text-anchor": "middle" }, svg).textContent = String(Math.ceil(ply / 2));
    }
    if (selected != null && selected > 0) {
      const line = el("line", { x1: x(selected), x2: x(selected), y1: top, y2: plotBottom, class: "selected" }, svg);
      svg.insertBefore(line, svg.querySelector(".selected-dot"));
    }
    this.hover = el("line", { y1: top, y2: plotBottom, class: "hover", visibility: "hidden" }, svg);

    svg.addEventListener("mousemove", (e) => { this.pointer = { clientX: e.clientX }; this.onMove(this.pointer, svg); });
    svg.addEventListener("mouseleave", () => {
      this.pointer = null;
      this.tip.hidden = true;
      this.hover.setAttribute("visibility", "hidden");
    });
    svg.addEventListener("click", (e) => {
      const ply = this.plyAt(e, svg);
      if (ply != null) this.onSelect(ply);
    });
    // redrawn under a resting pointer, keep its crosshair
    if (this.pointer) this.onMove(this.pointer, svg);
  }

  // a toggle per line, and overlay or stacked
  renderLegend(available, name) {
    const keys = available.map((key) =>
      `<button class="key ${key}${this.shown[key] ? " on" : ""}" data-series="${key}" title="show or hide this line"><i></i>${escapeHtml(name[key])}</button>`).join("");
    const modes = [["overlay", "overlay"], ["stack", "stacked"]].map(([mode, text]) =>
      `<button data-mode="${mode}" class="${this.mode === mode ? "on" : ""}">${text}</button>`).join("");
    const html = `<div class="keys">${keys}</div><div class="seg">${modes}</div>`;
    if (this.legendHtml !== html) {
      this.legend.innerHTML = html;
      this.legendHtml = html;
    }
  }

  plyAt(e, svg) {
    const rect = svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const ply = Math.round(((px - this.left) / (this.width - this.left - this.right)) * this.plies);
    const count = this.data.moves.length;
    if (count === 0) return null;
    return Math.min(Math.max(ply, 1), count);
  }

  onMove(e, svg) {
    const ply = this.plyAt(e, svg);
    if (ply == null) return;
    const move = this.data.moves[ply - 1];
    const px = this.x(ply);
    this.hover.setAttribute("x1", px);
    this.hover.setAttribute("x2", px);
    this.hover.setAttribute("visibility", "visible");
    const number = this.data.label(ply);
    const detail = move.book ? "book" : `${formatEval(move.cp, move.mate)}${move.depth ? `  d${move.depth}` : ""}`;
    const refEval = this.data.ref?.[ply];
    const refText = refEval ? ` · ${escapeHtml(this.data.names.ref ?? "reference")} ${refEval.over ? "game over" : formatEval(refEval.cp, refEval.mate)}` : "";
    this.tip.innerHTML = `<b>${number} ${escapeHtml(move.san)}</b> <span>${detail}${refText}</span>`;
    this.tip.hidden = false;
    const tipWidth = this.tip.offsetWidth;
    this.tip.style.left = `${Math.min(Math.max(px - tipWidth / 2, 0), this.width - tipWidth)}px`;
  }
}
