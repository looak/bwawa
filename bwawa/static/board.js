// A chess board from a FEN: 64 squares made once, only their classes change after that, so 32 boards updating
// a few times a second stay cheap.

const NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const FILES = "abcdefgh";

export class Board {
  constructor(parent, { coords = false } = {}) {
    this.el = document.createElement("div");
    this.el.className = "board";
    this.squares = [];
    this.pieces = [];
    this.flipped = false;
    for (let i = 0; i < 64; i++) {
      const square = document.createElement("div");
      const piece = document.createElement("div");
      piece.className = "pc";
      square.appendChild(piece);
      this.el.appendChild(square);
      this.squares.push(square);
      this.pieces.push(piece);
    }
    this.coords = coords;
    this.key = null;
    this.layout();
    parent.appendChild(this.el);
  }

  // index 0 is the top left square as shown
  squareName(index) {
    const row = Math.floor(index / 8), col = index % 8;
    return this.flipped ? FILES[7 - col] + (row + 1) : FILES[col] + (8 - row);
  }

  layout() {
    this.squares.forEach((square, index) => {
      const row = Math.floor(index / 8), col = index % 8;
      square.className = "sq " + ((row + col) % 2 ? "dark" : "light");
      square.dataset.square = this.squareName(index);
      square.querySelectorAll(".coord").forEach((c) => c.remove());
      if (this.coords) {
        const name = this.squareName(index);
        if (col === 0) square.insertAdjacentHTML("beforeend", `<span class="coord rank">${name[1]}</span>`);
        if (row === 7) square.insertAdjacentHTML("beforeend", `<span class="coord file">${name[0]}</span>`);
      }
    });
  }

  flip() {
    this.flipped = !this.flipped;
    this.layout();
    const { fen, lastMove, check } = this;
    this.key = null;
    this.set(fen, lastMove, check);
  }

  // fen: the placement field is enough. lastMove: uci like e2e4. check: highlight the king of the side to move.
  set(fen, lastMove = null, check = false) {
    const key = `${fen}|${lastMove}|${check}`;
    if (key === this.key || !fen) return;
    this.key = key;
    this.fen = fen;
    this.lastMove = lastMove;
    this.check = check;
    const placement = fen.split(" ")[0];
    const turn = fen.split(" ")[1] || "w";
    const grid = {};   // square name -> piece char
    placement.split("/").forEach((rank, r) => {
      let file = 0;
      for (const ch of rank) {
        if (/\d/.test(ch)) file += Number(ch);
        else grid[FILES[file++] + (8 - r)] = ch;
      }
    });
    const from = lastMove ? lastMove.slice(0, 2) : null;
    const to = lastMove ? lastMove.slice(2, 4) : null;
    this.squares.forEach((square, index) => {
      const name = this.squareName(index);
      const ch = grid[name];
      const piece = this.pieces[index];
      if (ch) {
        const white = ch === ch.toUpperCase();
        piece.className = `pc ${white ? "white" : "black"} ${NAMES[ch.toLowerCase()]}`;
        square.classList.toggle("check", check && ch === (turn === "w" ? "K" : "k"));
      } else {
        piece.className = "pc";
        square.classList.remove("check");
      }
      square.classList.toggle("last", name === from || name === to);
    });
  }
}
