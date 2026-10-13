// The eval graph of a game: white's view over the plies, book moves shaded, hover for the move, click to show it.
import { formatEval } from "./format.js";

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

export class EvalGraph {
  constructor(parent, onSelect) {
    this.wrap = document.createElement("div");
    this.wrap.className = "graph";
    this.tip = document.createElement("div");
    this.tip.className = "tip";
    this.tip.hidden = true;
    parent.appendChild(this.wrap);
    this.wrap.appendChild(this.tip);
    this.onSelect = onSelect;
    this.data = null;
    new ResizeObserver(() => this.draw()).observe(this.wrap);
  }

  // moves: the game's move records, selected: ply shown on the board, live: {cp, mate} of the search in progress
  set(moves, selected, live, label = (ply) => `${Math.ceil(ply / 2)}${ply % 2 ? "." : "…"}`) {
    this.data = { moves, selected, live, label };
    this.draw();
  }

  draw() {
    if (!this.data) return;
    const { moves, selected, live } = this.data;
    const width = this.wrap.clientWidth || 600;
    const height = 150;
    const left = 30, right = 8, top = 8, bottom = 18;
    const plies = Math.max(moves.length + (live ? 1 : 0), 20);
    const x = (ply) => left + (ply / plies) * (width - left - right);
    const y = (v) => top + (1 - (v + 1) / 2) * (height - top - bottom);
    this.x = x;
    this.plies = plies;
    this.left = left;
    this.right = right;
    this.width = width;

    this.wrap.querySelector("svg")?.remove();
    const svg = el("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "graph-svg" });
    this.wrap.insertBefore(svg, this.tip);

    const defs = el("defs", {}, svg);
    const hatch = el("pattern", { id: "hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse",
                                  patternTransform: "rotate(45)" }, defs);
    el("line", { x1: 0, y1: 0, x2: 0, y2: 6, class: "hatch-line" }, hatch);
    const zero = y(0);
    el("clipPath", { id: "above" }, defs).appendChild(el("rect", { x: 0, y: 0, width, height: zero }));
    el("clipPath", { id: "below" }, defs).appendChild(el("rect", { x: 0, y: zero, width, height: height - zero }));

    // book moves, the opening before either engine searched
    let book = 0;
    while (book < moves.length && moves[book].book) book++;
    if (book > 0) {
      el("rect", { x: x(0), y: top, width: x(book) - x(0), height: height - top - bottom, fill: "url(#hatch)" }, svg);
      el("text", { x: x(book / 2), y: height - 5, class: "axis book-label", "text-anchor": "middle" }, svg)
        .textContent = "book";
    }

    // grid: 0, ±1, ±3 pawns
    for (const pawns of [-3, -1, 0, 1, 3]) {
      const gy = y(squash(pawns * 100, null));
      el("line", { x1: left, x2: width - right, y1: gy, y2: gy, class: pawns === 0 ? "zero" : "grid" }, svg);
      el("text", { x: left - 4, y: gy + 3, class: "axis", "text-anchor": "end" }, svg)
        .textContent = pawns > 0 ? `+${pawns}` : `${pawns}`;
    }
    // move numbers along the bottom
    const step = plies > 160 ? 40 : plies > 80 ? 20 : 10;
    for (let ply = step; ply < plies; ply += step) {
      el("text", { x: x(ply), y: height - 5, class: "axis", "text-anchor": "middle" }, svg)
        .textContent = String(Math.ceil(ply / 2));
    }

    // the eval line, cut where a move has no eval
    const points = moves.map((m, i) => [x(i + 1), squash(m.cp, m.mate)]);
    const segments = [];
    let current = [];
    for (const [px, v] of points) {
      if (v == null) { if (current.length) segments.push(current); current = []; continue; }
      current.push([px, y(v)]);
    }
    if (current.length) segments.push(current);
    for (const seg of segments) {
      const line = seg.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
      const area = `${line}L${seg[seg.length - 1][0].toFixed(1)},${zero}L${seg[0][0].toFixed(1)},${zero}Z`;
      el("path", { d: area, class: "area-white", "clip-path": "url(#above)" }, svg);
      el("path", { d: area, class: "area-black", "clip-path": "url(#below)" }, svg);
      el("path", { d: line, class: "eval-line" }, svg);
    }
    // the search in progress, from the last eval to where it stands now
    const liveValue = live ? squash(live.cp, live.mate) : null;
    if (liveValue != null) {
      const last = [...points].reverse().find(([, v]) => v != null);
      if (last) el("line", { x1: last[0], y1: y(last[1]), x2: x(moves.length + 1), y2: y(liveValue), class: "live-line" }, svg);
      el("circle", { cx: x(moves.length + 1), cy: y(liveValue), r: 4, class: "live-dot" }, svg);
    }
    // the ply on the board
    if (selected != null && selected > 0) {
      el("line", { x1: x(selected), x2: x(selected), y1: top, y2: height - bottom, class: "selected" }, svg);
      const v = points[selected - 1]?.[1];
      if (v != null) el("circle", { cx: x(selected), cy: y(v), r: 4, class: "selected-dot" }, svg);
    }
    this.hover = el("line", { y1: top, y2: height - bottom, class: "hover", visibility: "hidden" }, svg);

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
    this.tip.innerHTML = `<b>${number} ${move.san}</b> <span>${detail}</span>`;
    this.tip.hidden = false;
    const tipWidth = this.tip.offsetWidth;
    this.tip.style.left = `${Math.min(Math.max(px - tipWidth / 2, 0), this.width - tipWidth)}px`;
  }
}
