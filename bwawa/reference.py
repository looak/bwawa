"""A reference engine (Stockfish, say) evaluating the positions of the games someone is looking at.

A live game is analysed while a client watches it, its newest position first, then back towards the start. A finished
game only when a client asks for it. One engine process, one position at a time, each searched to the same node
count so the evals compare across positions and games.
"""
from __future__ import annotations

import asyncio
import sys
from typing import Callable

import chess
import chess.engine

from .games import Game, Tracker, pv_to_san

IDLE_SECONDS = 0.25


class Reference:
    def __init__(self, path: str, tracker: Tracker, nodes: int, threads: int = 1, hash_mb: int = 64):
        self.path = path
        self.tracker = tracker
        self.nodes = nodes
        self.options = {"Threads": threads, "Hash": hash_mb}
        self.name: str | None = None
        self.error: str | None = None
        self.evals: dict[int, dict[int, dict]] = {}   # game id -> ply -> eval of the position after that ply
        self.requested: list[int] = []                 # finished games asked for, oldest request first
        self.watching: Callable[[], set[int]] = set   # ids of the games clients have open, set by the server
        self.engine: chess.engine.UciProtocol | None = None

    def request(self, game_id: int) -> None:
        if game_id in self.tracker.games and game_id not in self.requested:
            self.requested.append(game_id)
            self.touch(game_id)

    def view(self, game: Game) -> dict:
        evals = self.evals.get(game.id, {})
        return {"engine": self.name, "nodes": self.nodes, "error": self.error,
                "evals": [evals.get(ply) for ply in range(len(game.moves) + 1)],
                "analyzing": game.id in self.requested}

    def touch(self, game_id: int) -> None:
        game = self.tracker.games.get(game_id)
        if game is not None:
            game.version += 1

    # --- the work ---
    def next_job(self) -> tuple[Game, int] | None:
        games = self.tracker.games
        for game_id in sorted(self.watching()):
            game = games.get(game_id)
            if game is None or game.status != "live":
                continue
            done = self.evals.get(game_id, {})
            for ply in range(len(game.moves), -1, -1):
                if ply not in done:
                    return game, ply
        for game_id in list(self.requested):
            game = games.get(game_id)
            done = self.evals.get(game_id, {})
            missing = None if game is None else next((p for p in range(len(game.moves) + 1) if p not in done), None)
            if missing is not None:
                return game, missing
            self.requested.remove(game_id)
            self.touch(game_id)
        return None

    async def run(self) -> None:
        try:
            _, self.engine = await chess.engine.popen_uci(self.path)
            await self.engine.configure({k: v for k, v in self.options.items() if k in self.engine.options})
            self.name = self.engine.id.get("name", self.path)
            print(f"bwawa: reference engine {self.name}, {self.nodes} nodes a position", file=sys.stderr)
            while True:
                job = self.next_job()
                if job is None:
                    await asyncio.sleep(IDLE_SECONDS)
                    continue
                game, ply = job
                fen = game.start_fen if ply == 0 else game.moves[ply - 1].fen
                self.evals.setdefault(game.id, {})[ply] = await self.evaluate(chess.Board(fen))
                self.touch(game.id)
        except asyncio.CancelledError:
            raise
        except Exception as error:   # a missing binary, a crash: say so in the UI, the rest keeps running
            self.error = f"{type(error).__name__}: {error}"
            print(f"bwawa: reference engine stopped, {self.error}", file=sys.stderr)
            for game_id in self.requested:
                self.touch(game_id)
        finally:
            if self.engine is not None:
                try:
                    await asyncio.wait_for(self.engine.quit(), 2)
                except Exception:
                    pass

    async def evaluate(self, board: chess.Board) -> dict:
        """cp & mate from white's view, like the engines' own evals; a finished position gets its outcome instead."""
        outcome = board.outcome(claim_draw=False)
        if outcome is not None:
            if outcome.winner is None:
                return {"cp": 0, "mate": None, "over": True}
            return {"cp": None, "mate": 1 if outcome.winner == chess.WHITE else -1, "over": True}
        assert self.engine is not None
        info = await self.engine.analyse(board, chess.engine.Limit(nodes=self.nodes))
        score = info["score"].white()
        pv = [move.uci() for move in info.get("pv", [])]
        return {"cp": score.score(), "mate": score.mate(), "depth": info.get("depth"),
                "pv": pv_to_san(board, pv, limit=12)}
