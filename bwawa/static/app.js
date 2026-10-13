// bwawa's web UI: the set view (every live game, match stats, finished games) and the game view (one game in full).
import { Board } from "./board.js";
import { EvalGraph } from "./chart.js";
import { escapeHtml, evalShare, formatClock, formatCount, formatEval, formatMs, resultText } from "./format.js";

const state = {
  games: new Map(),     // id -> summary
  stats: null,
  detail: null,         // the watched game in full
  watch: null,          // id of the game in the game view
  ply: null,            // ply shown in the game view, null follows the game
  loaded: false,
};
const ticks = new Map();   // id -> {key, at}: when the side to move started thinking, as seen here
let socket = null;

const $ = (selector, root = document) => root.querySelector(selector);

function stored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window */ }
}

// ---------- connection ----------

function connect() {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  socket = new WebSocket(url);
  socket.onopen = () => {
    setConnection(true);
    if (state.watch != null) send({ watch: state.watch });
  };
  socket.onclose = () => {
    setConnection(false);
    setTimeout(connect, 1500);
  };
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.type === "games") onGames(data);
    else if (data.type === "game") onGame(data.game);
  };
}

function send(command) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(command));
}

function setConnection(up) {
  const el = $("#conn");
  el.textContent = up ? "live" : "reconnecting…";
  el.className = up ? "conn up" : "conn down";
  if (!up) state.games.clear();
}

function onGames(data) {
  for (const game of data.games) {
    state.games.set(game.id, game);
    noteTick(game);
  }
  for (const id of data.gone) state.games.delete(id);
  state.stats = data.stats;
  renderSet();
  if (state.watch != null && !state.games.has(state.watch) && state.loaded) renderMissing();
  state.loaded = true;
}

function onGame(game) {
  if (game.id !== state.watch) return;
  noteTick(game);
  state.detail = game;
  renderGame();
}

// A clock runs from when the side to move got its go, the log only gives clocks at go time.
function noteTick(game) {
  const key = game.live ? `${game.ply}:${game.live.white}` : null;
  const tick = ticks.get(game.id);
  if (!tick || tick.key !== key) ticks.set(game.id, { key, at: performance.now() });
}

function clockNow(game, white) {
  const side = white ? "white" : "black";
  if (game.live && game.live.white === white && game.live.clock != null) {
    const tick = ticks.get(game.id);
    return game.live.clock - (tick ? performance.now() - tick.at : 0);
  }
  return game.clocks ? game.clocks[side] : null;
}

// ---------- names ----------

function engineTitle(name) {
  const id = state.stats?.engines?.[name];
  return id && id !== name ? `${name} (${id})` : name ?? "";
}

// ---------- set view: stats ----------

function perspective(pairs) {
  // a gauntlet's center engine plays in every pair, its view first; a single pair can be flipped by click
  const flips = stored("bwawa.flip", {});
  const counts = {};
  for (const p of pairs) { counts[p.a] = (counts[p.a] || 0) + 1; counts[p.b] = (counts[p.b] || 0) + 1; }
  const center = pairs.length > 1 ? Object.keys(counts).find((name) => counts[name] === pairs.length) : null;
  return pairs.map((p) => {
    let flip = center ? p.b === center : false;
    if (flips[`${p.a}|${p.b}`]) flip = !flip;
    if (!flip) return { ...p, key: `${p.a}|${p.b}` };
    return { key: `${p.a}|${p.b}`, a: p.b, b: p.a, w: p.l, d: p.d, l: p.w,
             score: p.score == null ? null : 1 - p.score, elo: p.elo == null ? null : -p.elo, error: p.error };
  });
}

function eloText(p) {
  if (p.elo == null) {
    if (p.score === 1) return "+∞";
    if (p.score === 0) return "−∞";
    return "–";
  }
  const sign = p.elo > 0 ? "+" : p.elo < 0 ? "−" : "±";
  return `${sign}${Math.abs(p.elo).toFixed(1)}` + (p.error != null ? ` <small>± ${p.error.toFixed(1)}</small>` : "");
}

function pairRow(p) {
  const games = p.w + p.d + p.l;
  const pct = (n) => (games ? (100 * n) / games : 0);
  return `<div class="pair" data-key="${escapeHtml(p.key)}" title="click to swap sides">
    <div class="pair-names"><b title="${escapeHtml(engineTitle(p.a))}">${escapeHtml(p.a)}</b>
      <span class="vs">vs</span><span title="${escapeHtml(engineTitle(p.b))}">${escapeHtml(p.b)}</span></div>
    <div class="wdl">
      <span class="w">+${p.w}</span><span class="d">=${p.d}</span><span class="l">−${p.l}</span>
      <div class="wdl-bar"><i class="w" style="width:${pct(p.w)}%"></i><i class="d" style="width:${pct(p.d)}%"></i><i class="l" style="width:${pct(p.l)}%"></i></div>
    </div>
    <div class="stat"><span class="label">score</span><b>${p.score == null ? "–" : (100 * p.score).toFixed(1) + "%"}</b></div>
    <div class="stat"><span class="label">elo</span><b>${eloText(p)}</b></div>
    <div class="stat"><span class="label">games</span><b>${games}</b></div>
  </div>`;
}

let statsKey = null;
function renderStats() {
  const stats = state.stats;
  const live = [...state.games.values()].filter((g) => g.status === "live").length;
  const done = state.games.size - live;
  const pairs = stats ? perspective(stats.pairs) : [];
  const terms = stats ? Object.entries(stats.terminations).sort((a, b) => b[1] - a[1]) : [];
  const key = JSON.stringify([pairs, terms, live, done, stats?.engines]);
  if (key === statsKey) return;
  statsKey = key;
  $("#stats").innerHTML = `
    <div class="pairs">${pairs.length ? pairs.map(pairRow).join("") : `<div class="waiting">no results yet</div>`}</div>
    <div class="counts">
      <div><b>${live}</b> live · <b>${done}</b> finished</div>
      <div class="terms">${terms.map(([name, n]) => `<span class="chip">${escapeHtml(name)} <b>${n}</b></span>`).join("")}</div>
    </div>`;
}

// ---------- set view: the grid ----------

const cards = new Map();   // id -> card

function makeCard(game) {
  const el = document.createElement("a");
  el.className = "card";
  el.href = `#/game/${game.id}`;
  el.innerHTML = `
    <div class="player black"><span class="name"></span><span class="clock"></span></div>
    <div class="board-row"><div class="evalbar"><i></i></div><div class="board-wrap"></div></div>
    <div class="player white"><span class="name"></span><span class="clock"></span></div>
    <div class="meta"><span class="eval"></span><span class="depth"></span><span class="ply"></span></div>`;
  const card = { el, board: new Board($(".board-wrap", el)), key: null };
  return card;
}

function updateCard(card, game) {
  const el = card.el;
  card.board.set(game.fen, game.lastMove, /[+#]$/.test(game.lastSan || ""));
  const toMove = game.fen.split(" ")[1] === "w" ? "white" : "black";
  for (const side of ["white", "black"]) {
    const row = $(`.player.${side}`, el);
    const name = $(".name", row);
    const engine = game[side] ?? "?";
    if (name.textContent !== engine) { name.textContent = engine; name.title = engineTitle(engine); }
    row.classList.toggle("to-move", toMove === side);
  }
  $(".evalbar i", el).style.height = `${(100 * evalShare(game.cp, game.mate)).toFixed(1)}%`;
  $(".eval", el).textContent = formatEval(game.cp, game.mate);
  const live = game.live;
  $(".depth", el).textContent = live?.depth ? `d${live.depth}${live.seldepth ? "/" + live.seldepth : ""}` : "";
  $(".ply", el).textContent = `move ${game.fen.split(" ")[5] || ""}`;
  el.title = `slot ${game.slot}`;
}

function renderGrid() {
  const grid = $("#grid");
  const live = [...state.games.values()].filter((g) => g.status === "live")
    .sort((a, b) => a.slot.localeCompare(b.slot, undefined, { numeric: true }) || a.id - b.id);
  const ids = new Set(live.map((g) => g.id));
  for (const [id, card] of cards) {
    if (!ids.has(id)) { card.el.remove(); cards.delete(id); }
  }
  live.forEach((game, index) => {
    let card = cards.get(game.id);
    if (!card) { card = makeCard(game); cards.set(game.id, card); }
    updateCard(card, game);
    if (grid.children[index] !== card.el) grid.insertBefore(card.el, grid.children[index] || null);
  });
  $("#grid-empty").hidden = live.length > 0;
}

function tickClocks() {
  for (const [id, card] of cards) {
    const game = state.games.get(id);
    if (!game) continue;
    for (const side of ["white", "black"]) {
      const clock = $(`.player.${side} .clock`, card.el);
      const text = formatClock(clockNow(game, side === "white"));
      if (clock.textContent !== text) clock.textContent = text;
    }
  }
  if (state.detail && !$("#game").hidden) {
    for (const side of ["white", "black"]) {
      const text = formatClock(clockNow(state.detail, side === "white"));
      const clock = $(`#gv-board .player.${side} .clock`);
      if (clock && clock.textContent !== text) clock.textContent = text;
    }
  }
}

// ---------- set view: finished games ----------

let resultsKey = null;
const seenFinished = new Set();
let showAll = false;
const RESULTS_SHOWN = 100;

function renderResults() {
  const done = [...state.games.values()].filter((g) => g.status !== "live").sort((a, b) => b.id - a.id);
  const key = done.map((g) => `${g.id}:${g.result}:${g.termination}`).join(",") + showAll;
  if (key === resultsKey) return;
  resultsKey = key;
  const first = seenFinished.size === 0;
  const shown = showAll ? done : done.slice(0, RESULTS_SHOWN);
  $("#results-count").textContent = done.length ? `${done.length}` : "";
  $("#results tbody").innerHTML = shown.map((g) => {
    const fresh = !first && !seenFinished.has(g.id);
    const result = g.status === "abandoned" && !g.result ? "…" : resultText(g.result);
    const term = g.termination ?? (g.status === "abandoned" ? "waiting for the PGN" : "");
    const cls = g.result === "1-0" ? "r-white" : g.result === "0-1" ? "r-black" : g.result ? "r-draw" : "r-none";
    return `<tr class="${fresh ? "fresh" : ""}" data-id="${g.id}">
      <td class="num">${g.id}</td>
      <td class="name" title="${escapeHtml(engineTitle(g.white))}">${escapeHtml(g.white ?? "?")}</td>
      <td class="result ${cls}">${result}</td>
      <td class="name" title="${escapeHtml(engineTitle(g.black))}">${escapeHtml(g.black ?? "?")}</td>
      <td class="term">${escapeHtml(term)}</td>
      <td class="num">${lastMoveNumber(g)}</td>
      <td class="num muted">${escapeHtml(g.slot)}</td></tr>`;
  }).join("");
  done.forEach((g) => seenFinished.add(g.id));
  const more = $("#results-more");
  more.hidden = done.length <= RESULTS_SHOWN;
  more.textContent = showAll ? "show fewer" : `show all ${done.length}`;
  $("#results-empty").hidden = done.length > 0;
}

function renderSet() {
  renderStats();
  if (!$("#set").hidden) {
    renderGrid();
    renderResults();
  }
}

// ---------- game view ----------

const view = { board: null, graph: null, movesKey: null, telemetryKey: null };

function openGame(id) {
  state.watch = id;
  state.ply = null;
  state.detail = null;
  send({ watch: id });
  $("#set").hidden = true;
  $("#game").hidden = false;
  $("#gv-title").textContent = `game ${id}`;
  $("#gv-moves tbody").innerHTML = "";
  view.movesKey = null;
  view.telemetryKey = null;
  view.selectedPly = null;
  view.scrolled = false;
  fetch(`/api/game/${id}`).then((r) => (r.ok ? r.json() : null)).then((game) => {
    if (game && state.watch === id && !state.detail) onGame(game);
    else if (!game && state.watch === id) renderMissing();
  });
}

function openSet() {
  state.watch = null;
  state.detail = null;
  send({ watch: null });
  $("#game").hidden = true;
  $("#set").hidden = false;
  resultsKey = null;
  renderSet();
}

function renderMissing() {
  if (state.detail) return;
  $("#gv-title").textContent = `game ${state.watch} isn't tracked any more`;
}

function shownPly(game) {
  return state.ply == null ? game.moves.length : Math.min(state.ply, game.moves.length);
}

function selectPly(ply) {
  const game = state.detail;
  if (!game) return;
  ply = Math.max(0, Math.min(ply, game.moves.length));
  state.ply = ply === game.moves.length && game.status === "live" ? null : ply;
  renderGame();
}

// move number & side of a game's ply (1 is the first move played), counted from the start position's fen
function plyNumber(game, ply) {
  const fields = (game.startFen || "").split(" ");
  const half = ply - 1 + (fields[1] === "b" ? 1 : 0);
  const first = Number(fields[5]) || 1;
  return { number: first + Math.floor(half / 2), white: half % 2 === 0 };
}

// the number of the game's last move, counted like the move list (from the start FEN, not from ply 0)
function lastMoveNumber(game) {
  const fields = (game.fen || "").split(" ");
  const next = Number(fields[5]);
  if (!next) return Math.ceil(game.ply / 2);
  return fields[1] === "w" ? next - 1 : next;
}

function plyLabel(game, ply) {
  const { number, white } = plyNumber(game, ply);
  return `${number}${white ? "." : "…"}`;
}

function fenAt(game, ply) {
  return ply === 0 ? game.startFen : game.moves[ply - 1].fen;
}

// a SAN line with move numbers, its first move played at the game's ply
function pvLine(game, san, ply) {
  return san.map((move, i) => {
    const { number, white } = plyNumber(game, ply + i);
    const label = white ? `${number}. ` : i === 0 ? `${number}… ` : "";
    return `<span class="pv-move">${label}${escapeHtml(move)}</span>`;
  }).join(" ");
}

function renderGame() {
  const game = state.detail;
  if (!game) return;
  const ply = shownPly(game);
  const following = state.ply == null;
  const status = game.status === "live" ? "live" : game.status === "abandoned" && !game.result ? "ended, result pending"
    : `${resultText(game.result)}${game.termination ? ", " + game.termination : ""}`;
  $("#gv-title").innerHTML = `<span title="${escapeHtml(engineTitle(game.white))}">${escapeHtml(game.white ?? "?")}</span>
    <span class="vs">vs</span> <span title="${escapeHtml(engineTitle(game.black))}">${escapeHtml(game.black ?? "?")}</span>`;
  $("#gv-status").textContent = status;
  $("#gv-status").className = `status ${game.status}`;
  $("#gv-slot").textContent = `game ${game.id} · slot ${game.slot}`;

  // board & players
  const move = ply > 0 ? game.moves[ply - 1] : null;
  view.board.set(fenAt(game, ply), move?.uci ?? null, /[+#]$/.test(move?.san || ""));
  const flipped = view.board.flipped;
  const top = flipped ? "white" : "black", bottom = flipped ? "black" : "white";
  const toMove = game.fen.split(" ")[1] === "w" ? "white" : "black";
  for (const [pos, side] of [["top", top], ["bottom", bottom]]) {
    const row = $(`#gv-board .player.${pos}`);
    row.className = `player ${pos} ${side}${game.status === "live" && toMove === side ? " to-move" : ""}`;
    $(".name", row).textContent = game[side] ?? "?";
    $(".name", row).title = engineTitle(game[side]);
  }
  // the eval bar shows the position on the board: the live search when following, the move's eval otherwise
  let barCp = move?.cp, barMate = move?.mate;
  if (following && game.liveSearch) { barCp = game.liveSearch.cp; barMate = game.liveSearch.mate; }
  else if (following) { barCp = game.cp; barMate = game.mate; }
  $("#gv-board .evalbar i").style.height = `${(100 * evalShare(barCp, barMate)).toFixed(1)}%`;
  $("#gv-board .evalbar").classList.toggle("flipped", flipped);
  $("#gv-eval").textContent = formatEval(barCp, barMate);

  const ref = game.reference;
  const refEval = ref?.evals[ply];
  if (refEval) $("#gv-eval").textContent += ` · ${refName(ref)} ${refText(refEval)}`;
  renderAnalyze(game);

  $("#gv-follow").classList.toggle("on", following);
  $("#gv-follow").textContent = game.status === "live" ? (following ? "● following" : "follow game") : "last move";
  $("#gv-plyinfo").textContent = move ? `${plyLabel(game, ply)} ${move.san}` : "start position";

  // the PV the mover had for the move on the board
  const pvAt = $("#gv-pvat");
  if (move && !following) {
    pvAt.hidden = false;
    pvAt.innerHTML = move.book ? `<span class="muted">book move</span>`
      : `<span class="label">pv for this move${move.depth ? `, d${move.depth}` : ""}</span> ${pvLine(game, move.pv || [], ply)}`;
  } else pvAt.hidden = true;

  renderLive(game);
  renderMoves(game, ply);
  renderTelemetry(game);
  const live = following && game.liveSearch ? { ...game.liveSearch, white: game.live?.white } : null;
  view.graph.set(game.moves, ply, live, {
    label: (p) => plyLabel(game, p), ref: ref?.evals ?? null,
    names: { white: game.white, black: game.black, ref: ref ? refName(ref) : null },
  });
}

// ---------- the reference engine ----------

// the engine's name without its version, "Stockfish 17.1" is "Stockfish"
function refName(ref) {
  return (ref.engine || "reference").split(" ")[0];
}

function refText(e) {
  return e.over ? "game over" : formatEval(e.cp, e.mate) + (e.depth ? ` d${e.depth}` : "");
}

// a finished game is analysed when asked, a live one by itself while it's open
function renderAnalyze(game) {
  const button = $("#gv-analyze");
  const ref = game.reference;
  button.hidden = !ref || game.status === "live";
  if (button.hidden) return;
  const done = ref.evals.filter(Boolean).length, total = ref.evals.length;
  button.disabled = !!ref.error || ref.analyzing || done === total;
  button.title = ref.error ? `the reference engine stopped: ${ref.error}` : `${ref.engine ?? ""}, ${formatCount(ref.nodes)} nodes a position`;
  button.textContent = ref.error ? `${refName(ref)} stopped`
    : ref.analyzing ? `analyzing ${done}/${total}`
    : done === total ? `analyzed by ${refName(ref)}`
    : done ? `analyze the rest with ${refName(ref)}` : `analyze with ${refName(ref)}`;
}

function renderLive(game) {
  const el = $("#gv-live");
  const s = game.liveSearch;
  if (game.status !== "live") {
    el.innerHTML = `<h3>search</h3><div class="muted">the game is over</div>`;
    return;
  }
  if (!s) {
    el.innerHTML = `<h3>search</h3><div class="muted">${game.live ? `${escapeHtml(game.live.engine)} is thinking, no info yet` : "waiting for the next go"}</div>`;
    return;
  }
  const side = game.live?.white ? "white" : "black";
  el.innerHTML = `<h3><span class="dot ${side}"></span>${escapeHtml(s.engine)} <span class="muted">to move</span></h3>
    <div class="kv-row">
      <div><span class="label">eval</span><b>${formatEval(s.cp, s.mate) || "–"}</b></div>
      <div><span class="label">depth</span><b>${s.depth ?? "–"}${s.seldepth ? `<small>/${s.seldepth}</small>` : ""}</b></div>
      <div><span class="label">nodes</span><b>${formatCount(s.nodes)}</b></div>
      <div><span class="label">nps</span><b>${formatCount(s.nps)}</b></div>
      ${s.hashfull != null ? `<div><span class="label">hash</span><b>${(s.hashfull / 10).toFixed(1)}%</b></div>` : ""}
      <div><span class="label">time</span><b>${formatMs(s.time) || "–"}</b></div>
    </div>
    <div class="pv">${pvLine(game, s.pv || [], game.moves.length + 1)}</div>${refLive(game)}`;
}

// the reference engine's eval of the position being searched
function refLive(game) {
  const ref = game.reference;
  const e = ref?.evals[game.moves.length];
  if (!ref) return "";
  if (!e) return `<div class="ref-live muted">${escapeHtml(refName(ref))} ${ref.error ? "stopped" : "is looking"}…</div>`;
  return `<div class="ref-live"><span class="label">${escapeHtml(refName(ref))}</span> <b>${refText(e)}</b>
    <span class="pv">${pvLine(game, e.pv || [], game.moves.length + 1)}</span></div>`;
}

function moveCells(m) {
  return [
    `<td class="san">${escapeHtml(m.san)}</td>`,
    `<td class="num ev">${m.book ? `<span class="book">book</span>` : formatEval(m.cp, m.mate)}</td>`,
    `<td class="num ref-col"></td>`,
    `<td class="num">${m.depth ?? ""}${m.seldepth ? `<small>/${m.seldepth}</small>` : ""}</td>`,
    `<td class="num">${formatMs(m.think_ms)}</td>`,
    `<td class="num muted clock-cell">${m.clock_ms != null ? formatClock(m.clock_ms) : ""}</td>`,
  ].join("");
}

// One row per move number, white's move and black's side by side. Rows are only appended, a long game stays cheap.
function renderMoves(game, ply) {
  const body = $("#gv-moves tbody");
  if (view.movesKey !== game.id || view.movesShown > game.moves.length) {
    body.innerHTML = "";
    view.movesKey = game.id;
    view.movesShown = 0;
    view.rows = new Map();   // move number -> tr
    view.refShown = [];      // ply -> the reference eval text shown
  }
  const scroller = $("#gv-moves-scroll");
  const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 30;
  const empty = `<td class="san"></td><td></td><td class="ref-col"></td><td></td><td></td><td></td>`;
  for (let i = view.movesShown; i < game.moves.length; i++) {
    const m = game.moves[i];
    const { number, white } = plyNumber(game, m.ply);
    let tr = view.rows.get(number);
    if (!tr) {
      tr = document.createElement("tr");
      tr.innerHTML = `<td class="num muted">${number}.</td>${empty}<td class="gap"></td>${empty}`;
      body.appendChild(tr);
      view.rows.set(number, tr);
    }
    const cells = [...tr.children];
    const from = white ? 1 : 8;
    const holder = document.createElement("tbody");
    holder.innerHTML = `<tr>${moveCells(m)}</tr>`;
    [...holder.firstChild.children].forEach((td, k) => {
      td.dataset.ply = String(m.ply);
      tr.replaceChild(td, cells[from + k]);
    });
  }
  view.movesShown = game.moves.length;
  // the reference engine's eval of the position after each move, filled in as it gets to them
  const ref = game.reference;
  $("#gv-moves").classList.toggle("no-ref", !ref?.evals.some(Boolean));
  if (ref) {
    document.querySelectorAll("#gv-moves th.ref-col").forEach((th) => { th.textContent = refName(ref).toLowerCase(); th.title = ref.engine ?? ""; });
    for (let p = 1; p <= game.moves.length; p++) {
      const e = ref.evals[p];
      const text = e ? (e.over ? "–" : formatEval(e.cp, e.mate)) : "";
      if (view.refShown[p] === text) continue;
      view.refShown[p] = text;
      const td = body.querySelector(`td.ref-col[data-ply="${p}"]`);
      if (td) td.textContent = text;
    }
  }
  if (view.selectedPly !== ply || view.selectedGame !== game.id) {
    body.querySelectorAll("td.sel").forEach((td) => td.classList.remove("sel"));
    body.querySelectorAll(`td[data-ply="${ply}"]`).forEach((td) => td.classList.add("sel"));
    view.selectedPly = ply;
    view.selectedGame = game.id;
  }
  const current = body.querySelector(`td[data-ply="${ply}"]`)?.parentElement;
  if (state.ply == null) {
    if (atBottom || !view.scrolled) { scroller.scrollTop = scroller.scrollHeight; view.scrolled = true; }
  } else if (current) {
    const top = current.offsetTop, bottom = top + current.offsetHeight;
    if (top < scroller.scrollTop + 24 || bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = top - scroller.clientHeight / 2;
    }
  }
}

// ---------- telemetry ----------

const COMMON = new Set(["v", "type", "engine", "pid", "t", "fen", "moves", "search"]);

function renderValue(value) {
  if (value == null) return `<span class="muted">–</span>`;
  if (Array.isArray(value)) {
    if (value.length && value.every((v) => v && typeof v === "object" && !Array.isArray(v))) {
      const keys = [...new Set(value.flatMap((v) => Object.keys(v)))];
      return `<table class="tt"><thead><tr>${keys.map((k) => `<th>${escapeHtml(k)}</th>`).join("")}</tr></thead>
        <tbody>${value.map((v) => `<tr>${keys.map((k) => `<td>${cell(v[k])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    }
    return escapeHtml(value.join(" "));
  }
  if (typeof value === "object") {
    return `<dl class="kv">${Object.entries(value).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${renderValue(v)}</dd>`).join("")}</dl>`;
  }
  return cell(value);
}

function cell(value) {
  if (typeof value === "number") return value >= 10000 ? formatCount(value) : String(value);
  if (value && typeof value === "object") return escapeHtml(JSON.stringify(value));
  return escapeHtml(value ?? "");
}

// the fields of a report beyond the common ones and the ones shown already
function rest(packet, shown) {
  if (!packet) return {};
  return Object.fromEntries(Object.entries(packet).filter(([k]) => !COMMON.has(k) && !shown.includes(k)));
}

function scoreText(p) {
  return p.mate != null ? (p.mate > 0 ? `#${p.mate}` : `#-${-p.mate}`) : p.cp != null ? `${p.cp}cp` : "";
}

function telemetrySide(side, t) {
  const parts = [];
  const hello = t.hello;
  const head = [hello?.version && `v${escapeHtml(hello.version)}`, hello?.threads != null && `${hello.threads} threads`,
                hello?.hash != null && `${hello.hash} MB hash`, t.pid != null && `pid ${t.pid}`].filter(Boolean).join(" · ");
  parts.push(`<h4><span class="dot ${side}"></span>${escapeHtml(t.engine ?? side)} <span class="muted">${head}</span></h4>`);

  const threads = Object.values(t.threads || {}).sort((a, b) => (a.thread ?? 0) - (b.thread ?? 0));
  if (threads.length) {
    parts.push(`<div class="label">search ${escapeHtml(t.searchId ?? "")}, per thread</div>
      <table class="tt threads"><thead><tr><th>thread</th><th>depth</th><th>score</th><th>nodes</th><th>ms</th><th>pv</th></tr></thead><tbody>
      ${threads.map((p) => `<tr><td>${p.thread ?? 0}</td><td>${p.depth ?? ""}${p.seldepth ? `<small>/${p.seldepth}</small>` : ""}</td>
        <td>${scoreText(p)}</td><td>${formatCount(p.nodes)}</td><td>${p.ms ?? ""}</td>
        <td class="pv-cell">${escapeHtml((p.pv || []).slice(0, 6).join(" "))}</td></tr>`).join("")}</tbody></table>`);
    const extra = threads.map((p) => rest(p, ["thread", "depth", "seldepth", "cp", "mate", "nodes", "ms", "pv"]))
      .filter((r) => Object.keys(r).length);
    if (extra.length) parts.push(renderValue(extra));
  }
  if (t.go) {
    const go = t.go;
    const plan = [go.soft_ms != null && `soft ${formatMs(go.soft_ms)}`, go.hard_ms != null && `hard ${formatMs(go.hard_ms)}`]
      .filter(Boolean).join(" · ");
    parts.push(`<div class="label">go</div><div>${plan || ""} ${go.limits ? `<span class="muted">${escapeHtml(Object.entries(go.limits).map(([k, v]) => `${k} ${v}`).join(" "))}</span>` : ""}</div>`);
    const more = rest(go, ["limits", "soft_ms", "hard_ms"]);
    if (Object.keys(more).length) parts.push(renderValue(more));
  }
  if (t.search) {
    const s = t.search;
    parts.push(`<div class="label">last search</div>
      <div class="kv-row small">
        ${s.bestmove ? `<div><span class="label">best</span><b>${escapeHtml(s.bestmove)}</b></div>` : ""}
        <div><span class="label">depth</span><b>${s.depth ?? "–"}</b></div>
        <div><span class="label">score</span><b>${scoreText(s) || "–"}</b></div>
        <div><span class="label">nodes</span><b>${formatCount(s.nodes)}</b></div>
        <div><span class="label">time</span><b>${formatMs(s.ms) || "–"}</b></div>
        ${s.stop ? `<div><span class="label">stop</span><b>${escapeHtml(s.stop)}</b></div>` : ""}
      </div>`);
    if (s.tt) {
      const tt = s.tt;
      const rate = tt.probes ? ` <span class="muted">hit rate ${((100 * (tt.hits ?? 0)) / tt.probes).toFixed(1)}%</span>` : "";
      parts.push(`<div class="label">transposition table${rate}</div>${renderValue(tt)}`);
    }
    if (Array.isArray(s.threads) && s.threads.length) parts.push(`<div class="label">threads at the end</div>${renderValue(s.threads)}`);
    if (s.extra) parts.push(`<div class="label">extra</div>${renderValue(s.extra)}`);
    const more = rest(s, ["bestmove", "depth", "cp", "mate", "nodes", "ms", "stop", "tt", "threads", "extra"]);
    if (Object.keys(more).length) parts.push(renderValue(more));
  }
  for (const [kind, packet] of Object.entries(t)) {
    if (["engine", "pid", "hello", "threads", "go", "search", "searchId"].includes(kind)) continue;
    parts.push(`<div class="label">${escapeHtml(kind)}</div>${renderValue(rest(packet, []))}`);
  }
  return `<div class="tm-side">${parts.join("")}</div>`;
}

function renderTelemetry(game) {
  const el = $("#gv-telemetry");
  const telemetry = game.telemetry || {};
  const key = JSON.stringify(telemetry);
  if (key === view.telemetryKey) return;
  view.telemetryKey = key;
  const sides = ["white", "black"].filter((side) => telemetry[side]);
  el.hidden = sides.length === 0;
  el.innerHTML = `<h3>telemetry</h3>${sides.map((side) => telemetrySide(side, telemetry[side])).join("")}`;
}

// ---------- setup ----------

function route() {
  const match = location.hash.match(/^#\/game\/(\d+)/);
  if (match) openGame(Number(match[1]));
  else openSet();
}

function setup() {
  view.board = new Board($("#gv-board .board-wrap"), { coords: true });
  view.graph = new EvalGraph($("#gv-graph"), selectPly);

  $("#gv-moves tbody").addEventListener("click", (e) => {
    const td = e.target.closest("td[data-ply]");
    if (td) selectPly(Number(td.dataset.ply));
  });
  $("#gv-moves-scroll").addEventListener("scroll", () => { view.scrolled = true; });
  $("#gv-first").onclick = () => selectPly(0);
  $("#gv-prev").onclick = () => selectPly(shownPly(state.detail) - 1);
  $("#gv-next").onclick = () => selectPly(shownPly(state.detail) + 1);
  $("#gv-last").onclick = () => selectPly(Infinity);
  $("#gv-follow").onclick = () => { state.ply = null; renderGame(); };
  $("#gv-analyze").onclick = () => { if (state.detail) send({ analyze: state.detail.id }); };
  $("#gv-flip").onclick = () => { view.board.flip(); renderGame(); };
  document.addEventListener("keydown", (e) => {
    if ($("#game").hidden || !state.detail || e.target.matches("input, textarea")) return;
    const ply = shownPly(state.detail);
    if (e.key === "ArrowLeft") selectPly(ply - 1);
    else if (e.key === "ArrowRight") selectPly(ply + 1);
    else if (e.key === "Home" || e.key === "ArrowUp") selectPly(0);
    else if (e.key === "End" || e.key === "ArrowDown") selectPly(Infinity);
    else if (e.key === "f") { view.board.flip(); renderGame(); }
    else if (e.key === "Escape") location.hash = "#/";
    else return;
    e.preventDefault();
  });

  $("#stats").addEventListener("click", (e) => {
    const pair = e.target.closest(".pair");
    if (!pair) return;
    const flips = stored("bwawa.flip", {});
    flips[pair.dataset.key] = !flips[pair.dataset.key];
    store("bwawa.flip", flips);
    statsKey = null;
    renderStats();
  });
  $("#results tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr");
    if (tr) location.hash = `#/game/${tr.dataset.id}`;
  });
  $("#results-more").onclick = () => { showAll = !showAll; resultsKey = null; renderResults(); };

  // card size, for 8 games on a laptop or 32 on a big screen
  const sizes = { s: "150px", m: "200px", l: "270px" };
  const applySize = (size) => {
    document.documentElement.style.setProperty("--card", sizes[size] || sizes.m);
    document.querySelectorAll("#sizes button").forEach((b) => b.classList.toggle("on", b.dataset.size === size));
  };
  applySize(stored("bwawa.size", "m"));
  $("#sizes").addEventListener("click", (e) => {
    const size = e.target.dataset?.size;
    if (!size) return;
    store("bwawa.size", size);
    applySize(size);
  });

  window.addEventListener("hashchange", route);
  route();
  connect();
  setInterval(tickClocks, 100);
}

setup();
