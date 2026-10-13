"""Inputs: a runner log followed as it grows, the runner's PGN for results, engine telemetry over UDP."""
from __future__ import annotations

import asyncio
import io
import json
import os
from typing import Callable

import chess
import chess.pgn

from .events import EngineIO, parse_fastchess_line
from .games import Tracker

POLL_SECONDS = 0.1


async def follow_lines(path: str, on_line: Callable[[str], None], on_reset: Callable[[], None] | None = None,
                       on_idle: Callable[[], None] | None = None) -> None:
    """Every line of path, the existing ones first, then new ones as they're written. A file that shrinks was
    started over (a new fastchess run), it's read again from the start."""
    position = 0
    pending = ""
    while True:
        try:
            size = os.path.getsize(path)
        except OSError:
            await asyncio.sleep(1.0)
            continue
        if size < position:
            position, pending = 0, ""
            if on_reset is not None:
                on_reset()
        if size > position:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                handle.seek(position)
                chunk = handle.read()
                position = handle.tell()
            lines = (pending + chunk).split("\n")
            pending = lines.pop()
            for line in lines:
                on_line(line)
            # yield between big chunks so the web server stays responsive while a long log is read.
            await asyncio.sleep(0)
            continue
        if on_idle is not None:
            on_idle()
        await asyncio.sleep(POLL_SECONDS)


async def follow_fastchess_log(path: str, tracker: Tracker) -> None:
    def on_line(line: str) -> None:
        event: EngineIO | None = parse_fastchess_line(line)
        if event is not None:
            tracker.handle(event)

    await follow_lines(path, on_line, on_reset=tracker.reset)


async def follow_pgn(path: str, tracker: Tracker) -> None:
    """Results & terminations of finished games, matched to the tracked games by start position & moves."""
    buffer: list[str] = []

    def flush() -> None:
        text = "\n".join(buffer)
        buffer.clear()
        game = chess.pgn.read_game(io.StringIO(text))
        if game is None:
            return
        headers = game.headers
        fen = headers.get("FEN", chess.STARTING_FEN)
        moves = [move.uci() for move in game.mainline_moves()]
        termination = headers.get("Termination")
        tracker.apply_result(fen, moves, headers.get("Result", "*"), termination,
                             headers.get("White"), headers.get("Black"))

    def has_moves() -> bool:
        return any(entry.strip() and not entry.startswith("[") for entry in buffer)

    def on_line(line: str) -> None:
        # a game is complete when the next one starts, fastchess writes each game in one go.
        if line.startswith("[Event ") and has_moves():
            flush()
        buffer.append(line)

    def on_idle() -> None:
        # the run's last game has no next one, it's complete once the file stops growing.
        if has_moves():
            flush()

    await follow_lines(path, on_line, on_idle=on_idle)


class TelemetryProtocol(asyncio.DatagramProtocol):
    """One JSON object per line, an engine sends one datagram per report."""

    def __init__(self, tracker: Tracker):
        self.tracker = tracker
        self.received = 0

    def datagram_received(self, data: bytes, addr) -> None:
        for line in data.decode("utf-8", errors="replace").splitlines():
            if not line.strip():
                continue
            try:
                packet = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(packet, dict):
                self.received += 1
                self.tracker.apply_telemetry(packet)


async def listen_telemetry(host: str, port: int, tracker: Tracker) -> TelemetryProtocol:
    loop = asyncio.get_running_loop()
    _, protocol = await loop.create_datagram_endpoint(lambda: TelemetryProtocol(tracker), local_addr=(host, port))
    return protocol
