"""Turns a stream of EngineIO events into games.

A runner plays games in slots, one after another per slot, several slots at once. The tracker keeps the current game
of every slot: who plays white & black, the moves with each engine's last info before it moved (score, depth, nodes,
time, pv), the clocks, the live search of the side to move and, when it's over, the result.
"""
from __future__ import annotations

import itertools
import math
import time as wallclock
from dataclasses import dataclass, field

import chess

from .events import FROM_ENGINE, TO_ENGINE, EngineIO
from .uci import Info, parse_bestmove, parse_go, parse_info, parse_position

MATE_SCORE = 100_000


def white_view(info: Info, white_to_move: bool) -> tuple[int | None, int | None]:
    """(centipawns, mate in moves) from white's side, UCI scores are the side to move's."""
    sign = 1 if white_to_move else -1
    cp = info.score_cp * sign if info.score_cp is not None else None
    mate = info.mate * sign if info.mate is not None else None
    return cp, mate


def pv_to_san(board: chess.Board, pv: list[str], limit: int = 24) -> list[str]:
    """The pv in SAN, cut where a move isn't legal (a pv from an older position, a truncated line)."""
    san: list[str] = []
    probe = board.copy(stack=False)
    for uci in pv[:limit]:
        try:
            move = chess.Move.from_uci(uci)
        except ValueError:
            break
        if move not in probe.legal_moves:
            break
        san.append(probe.san(move))
        probe.push(move)
    return san


@dataclass
class MoveRecord:
    ply: int
    uci: str
    san: str
    white: bool                     # white made the move
    book: bool = False              # came with the opening, no search
    cp: int | None = None           # white's view
    mate: int | None = None         # white's view
    depth: int | None = None
    seldepth: int | None = None
    nodes: int | None = None
    nps: int | None = None
    hashfull: int | None = None
    think_ms: int | None = None     # go to bestmove, measured by the runner's log
    clock_ms: int | None = None     # the mover's clock when it was asked to move
    pv: list[str] = field(default_factory=list)   # SAN, from the position before the move
    fen: str = ""                   # the position after the move

    def to_json(self) -> dict:
        return self.__dict__.copy()


@dataclass
class LiveSearch:
    engine: str
    white: bool
    started: float
    clock_ms: int | None
    inc_ms: int = 0
    info: Info | None = None
    pv_san: list[str] = field(default_factory=list)


_ids = itertools.count(1)


class Game:
    def __init__(self, slot: str, start_fen: str, now: float):
        self.id = next(_ids)
        self.slot = slot
        self.start_fen = start_fen
        self.board = chess.Board(start_fen)
        self.white: str | None = None
        self.black: str | None = None
        self.moves: list[MoveRecord] = []
        self.clocks: dict[str, int | None] = {"white": None, "black": None}
        self.live: LiveSearch | None = None
        self.status = "live"            # live | finished | abandoned
        self.result: str | None = None  # 1-0 0-1 1/2-1/2
        self.termination: str | None = None
        self.started = now
        self.updated = wallclock.time()
        self.telemetry: dict[str, dict] = {}   # engine name -> its latest telemetry packet for this game
        self.version = 0

    # --- moves ---
    def uci_moves(self) -> list[str]:
        return [move.uci for move in self.moves]

    def push(self, uci: str, book: bool) -> MoveRecord | None:
        try:
            move = chess.Move.from_uci(uci)
        except ValueError:
            return None
        if move not in self.board.legal_moves:
            return None
        record = MoveRecord(ply=len(self.moves) + 1, uci=uci, san=self.board.san(move),
                            white=self.board.turn == chess.WHITE, book=book)
        self.board.push(move)
        record.fen = self.board.fen()
        self.moves.append(record)
        self.touch()
        return record

    def check_over(self) -> None:
        outcome = self.board.outcome(claim_draw=True)
        if outcome is not None and self.status == "live":
            self.finish(outcome.result(), outcome.termination.name.lower().replace("_", " "))

    def finish(self, result: str | None, termination: str | None) -> None:
        self.status = "finished"
        self.result = result or self.result
        self.termination = termination or self.termination
        self.live = None
        self.touch()

    def touch(self) -> None:
        self.updated = wallclock.time()
        self.version += 1

    # --- views ---
    def last_eval(self) -> tuple[int | None, int | None]:
        if self.live and self.live.info and self.live.info.depth:
            return white_view(self.live.info, self.live.white)
        for record in reversed(self.moves):
            if record.cp is not None or record.mate is not None:
                return record.cp, record.mate
        return None, None

    def summary(self) -> dict:
        cp, mate = self.last_eval()
        last = self.moves[-1].uci if self.moves else None
        live = None
        if self.live is not None:
            info = self.live.info
            live = {"engine": self.live.engine, "white": self.live.white, "clock": self.live.clock_ms,
                    "depth": info.depth if info else None, "seldepth": info.seldepth if info else None,
                    "nodes": info.nodes if info else None, "nps": info.nps if info else None,
                    "pv": self.live.pv_san[:8]}
        return {"id": self.id, "slot": self.slot, "white": self.white, "black": self.black, "status": self.status,
                "result": self.result, "termination": self.termination, "fen": self.board.fen(), "lastMove": last,
                "ply": len(self.moves), "cp": cp, "mate": mate, "clocks": self.clocks, "live": live,
                "started": self.started, "updated": self.updated}

    def detail(self) -> dict:
        data = self.summary()
        data["startFen"] = self.start_fen
        data["moves"] = [record.to_json() for record in self.moves]
        if self.live is not None and self.live.info is not None:
            info = self.live.info
            cp, mate = white_view(info, self.live.white)
            data["liveSearch"] = {"engine": self.live.engine, "depth": info.depth, "seldepth": info.seldepth,
                                  "cp": cp, "mate": mate, "nodes": info.nodes, "nps": info.nps,
                                  "hashfull": info.hashfull, "time": info.time_ms, "pv": self.live.pv_san}
        data["telemetry"] = self.telemetry
        return data


def elo(wins: int, draws: int, losses: int) -> dict:
    """Score, Elo difference and its 95% error margin from the first engine's view, from the game results alone
    (trinomial, no game pairs). Elo is None while the score is 0 or 1."""
    games = wins + draws + losses
    if games == 0:
        return {"score": None, "elo": None, "error": None}
    score = (wins + draws / 2) / games

    def to_elo(value: float) -> float | None:
        if value <= 0 or value >= 1:
            return None
        return -400 * math.log10(1 / value - 1)

    variance = (wins * (1 - score) ** 2 + draws * (0.5 - score) ** 2 + losses * score ** 2) / games
    margin = 1.959964 * math.sqrt(variance / games)
    low, high = to_elo(score - margin), to_elo(score + margin)
    error = (high - low) / 2 if low is not None and high is not None else None
    return {"score": score, "elo": to_elo(score), "error": error}


class Tracker:
    """Keeps the current game of every slot and every finished one."""

    def __init__(self, keep_finished: int = 2000):
        self.slots: dict[str, Game] = {}
        self.games: dict[int, Game] = {}
        self.pending_new: set[str] = set()
        self.engine_ids: dict[str, str] = {}    # match name -> id name
        self.hellos: dict[tuple, dict] = {}     # (engine, pid) -> its telemetry hello
        self.keep_finished = keep_finished

    def reset(self) -> None:
        """Forget everything, the log started over."""
        self.__init__(self.keep_finished)

    # --- events ---
    def handle(self, event: EngineIO) -> None:
        if event.direction == TO_ENGINE:
            self._to_engine(event)
        else:
            self._from_engine(event)

    def _to_engine(self, event: EngineIO) -> None:
        text = event.text
        if text == "ucinewgame":
            self.pending_new.add(event.slot)
        elif text.startswith("position "):
            position = parse_position(text)
            if position is not None:
                self._sync_position(event, position.fen, position.moves)
        elif text.startswith("go"):
            game = self.slots.get(event.slot)
            if game is None or game.status != "live":
                return
            white = game.board.turn == chess.WHITE
            if white:
                game.white = game.white or event.engine
            else:
                game.black = game.black or event.engine
            go = parse_go(text)
            game.clocks = {"white": go.get("wtime"), "black": go.get("btime")}
            clock = go.get("wtime" if white else "btime")
            game.live = LiveSearch(event.engine, white, event.time, clock, go.get("winc" if white else "binc", 0))
            game.touch()

    def _from_engine(self, event: EngineIO) -> None:
        text = event.text
        if "id name " in text and (text.startswith("id name ") or text.lstrip("> ").startswith("id name ")):
            # some engines put a banner's last characters in front of it
            self.engine_ids[event.engine] = text.split("id name ", 1)[1].strip()
            return
        game = self.slots.get(event.slot)
        if game is None or game.live is None or game.live.engine != event.engine:
            return
        if text.startswith("info"):
            info = parse_info(text)
            if info is not None:
                game.live.info = info
                game.live.pv_san = pv_to_san(game.board, info.pv)
                game.touch()
        elif text.startswith("bestmove"):
            uci = parse_bestmove(text)
            live = game.live
            game.live = None
            if uci is None:
                return
            board_before = game.board.copy(stack=False)
            record = game.push(uci, book=False)
            if record is None:
                return
            info = live.info
            if info is not None:
                record.cp, record.mate = white_view(info, live.white)
                record.depth, record.seldepth = info.depth, info.seldepth
                record.nodes, record.nps, record.hashfull = info.nodes, info.nps, info.hashfull
                record.pv = pv_to_san(board_before, info.pv)
            record.think_ms = int((event.time - live.started) * 1000)
            record.clock_ms = live.clock_ms
            if live.clock_ms is not None:
                # the runner's next go says for sure, until then the clock the mover is left with.
                game.clocks["white" if live.white else "black"] = max(0, live.clock_ms - record.think_ms) + live.inc_ms
            game.check_over()

    def _sync_position(self, event: EngineIO, fen: str, moves: list[str]) -> None:
        game = self.slots.get(event.slot)
        new_game = (game is None or game.start_fen.split()[:4] != fen.split()[:4]
                    or moves[:len(game.moves)] != game.uci_moves())
        if not new_game and event.slot in self.pending_new and len(moves) < len(game.moves):
            new_game = True
        if new_game:
            if game is not None and game.status == "live":
                game.status = "abandoned"   # ended in a way the stream doesn't show: adjudication, time, a crash
                game.live = None
                game.touch()
            game = Game(event.slot, fen, event.time)
            self.slots[event.slot] = game
            self.games[game.id] = game
            self._trim()
        self.pending_new.discard(event.slot)
        # moves this game hasn't seen: the opening before anyone searched, later a move the log missed.
        book = all(record.book for record in game.moves)
        for uci in moves[len(game.moves):]:
            if game.push(uci, book=book) is None:
                break

    def _trim(self) -> None:
        finished = [g for g in self.games.values() if g.status != "live"]
        for game in finished[:max(0, len(finished) - self.keep_finished)]:
            del self.games[game.id]

    # --- results from PGN ---
    def apply_result(self, start_fen: str, moves: list[str], result: str, termination: str | None,
                     white: str | None, black: str | None) -> None:
        """A finished game's result from the runner's PGN, matched by its start position & moves."""
        for game in self.games.values():
            if game.start_fen.split()[:4] != start_fen.split()[:4]:
                continue
            ours = game.uci_moves()
            if ours != moves and not (game.status != "live" and moves[:len(ours)] == ours):
                continue
            if white and black and game.white and game.black and (white, black) != (game.white, game.black):
                continue
            # fastchess says "normal" for any decisive end, the board knows whether it was mate or a draw rule.
            if termination == "normal" and game.termination:
                termination = None
            game.finish(result, termination)
            return

    # --- telemetry ---
    def apply_telemetry(self, packet: dict) -> None:
        """An engine's own report, matched to the live game whose position it searched.

        Kept per side of the game: the engine's hello, the latest go and search reports and every thread's latest
        iteration of the current search. A search report can arrive after the log showed its bestmove, it then
        matches the position before that move."""
        kind = packet.get("type")
        if kind == "hello":
            self.hellos[(packet.get("engine"), packet.get("pid"))] = packet
            return
        fen = packet.get("fen") or "startpos"
        if fen == "startpos":
            fen = chess.STARTING_FEN
        moves = packet.get("moves")
        if not isinstance(moves, list):
            moves = []
        for game in self.slots.values():
            if game.status != "live" or game.start_fen.split()[:4] != fen.split()[:4]:
                continue
            ours = game.uci_moves()
            if ours == moves:
                white = game.board.turn == chess.WHITE
            elif kind == "search" and ours[:-1] == moves and ours:
                white = game.board.turn == chess.BLACK    # the move it chose is already on the board
            else:
                continue
            side = game.telemetry.setdefault("white" if white else "black", {})
            side["engine"], side["pid"] = packet.get("engine"), packet.get("pid")
            hello = self.hellos.get((packet.get("engine"), packet.get("pid")))
            if hello is not None:
                side["hello"] = hello
            if kind == "iteration":
                if side.get("searchId") != packet.get("search"):
                    side["threads"] = {}
                side["searchId"] = packet.get("search")
                side.setdefault("threads", {})[str(packet.get("thread", 0))] = packet
            elif kind == "go":
                side["go"] = packet
                side["searchId"] = packet.get("search")
                side["threads"] = {}
            else:
                side[kind if isinstance(kind, str) else "other"] = packet
            game.touch()
            return

    # --- views ---
    def summaries(self) -> list[dict]:
        return [game.summary() for game in self.games.values()]

    def stats(self) -> dict:
        """Results per engine pair, from the first named engine's view."""
        pairs: dict[tuple[str, str], list[int]] = {}
        terminations: dict[str, int] = {}
        for game in self.games.values():
            if game.status == "live" or not game.white or not game.black:
                continue
            terminations[game.termination or game.status] = terminations.get(game.termination or game.status, 0) + 1
            if game.result not in ("1-0", "0-1", "1/2-1/2"):
                continue
            a, b = sorted((game.white, game.black))
            wins_draws_losses = pairs.setdefault((a, b), [0, 0, 0])
            if game.result == "1/2-1/2":
                wins_draws_losses[1] += 1
            elif (game.result == "1-0") == (game.white == a):
                wins_draws_losses[0] += 1
            else:
                wins_draws_losses[2] += 1
        return {"pairs": [{"a": a, "b": b, "w": w, "d": d, "l": l, **elo(w, d, l)} for (a, b), (w, d, l) in pairs.items()],
                "terminations": terminations, "engines": self.engine_ids}
