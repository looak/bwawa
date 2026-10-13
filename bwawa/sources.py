"""Inputs: a runner log followed as it grows, the runner's PGN for results (or for the games themselves without a
log), engine telemetry over UDP, an OpenBench test's SPRT."""
from __future__ import annotations

import asyncio
import io
import html
import json
import os
import re
import sys
from typing import Callable

import aiohttp
import chess
import chess.pgn

from .events import EngineIO, parse_fastchess_line
from .games import Tracker

POLL_SECONDS = 0.1
CHUNK_CHARS = 1 << 18   # read a big file a piece at a time, the web server answers in between


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
                chunk = handle.read(CHUNK_CHARS)
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


async def follow_pgn(path: str, tracker: Tracker, import_games: bool = False) -> None:
    """Results & terminations of finished games, matched to the tracked games by start position & moves. With
    import_games, without a log to follow, every game in it becomes a finished game of its own."""
    buffer: list[str] = []

    def flush() -> None:
        text = "\n".join(buffer)
        buffer.clear()
        game = chess.pgn.read_game(io.StringIO(text))
        if game is None:
            return
        if import_games:
            tracker.import_game(game)
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


OPENBENCH_SECONDS = 20

# an OpenBench test page's stat block, its text once the tags are gone
OPENBENCH_FIELDS = {
    "llr": re.compile(r"LLR\s*\|\s*(-?[\d.]+)\s*\((-?[\d.]+),\s*(-?[\d.]+)\)\s*\[(-?[\d.]+),\s*(-?[\d.]+)\]"),
    "elo": re.compile(r"Elo\s*\|\s*(-?[\d.]+)\s*\+-\s*([\d.]+)"),
    "games": re.compile(r"Games\s*\|\s*N:\s*(\d+)\s*W:\s*(\d+)\s*L:\s*(\d+)\s*D:\s*(\d+)"),
    "penta": re.compile(r"Penta\s*\|\s*\[([\d,\s]+)\]"),
    "dev": re.compile(r"Dev Branch\s+(\S+)"),
    "base": re.compile(r"Base Branch\s+(\S+)"),
}


def parse_openbench(page: str) -> dict | None:
    """The SPRT of an OpenBench test page: LLR & its bounds, Elo, games, pentanomial; None for a page without one."""
    text = html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", page)))
    found = {name: pattern.search(text) for name, pattern in OPENBENCH_FIELDS.items()}
    if found["llr"] is None or found["games"] is None:
        return None
    llr, lower, upper, elo0, elo1 = (float(v) for v in found["llr"].groups())
    games, wins, losses, draws = (int(v) for v in found["games"].groups())
    return {
        "llr": llr, "lower": lower, "upper": upper, "elo0": elo0, "elo1": elo1,
        "games": games, "wins": wins, "losses": losses, "draws": draws,
        "elo": float(found["elo"][1]) if found["elo"] else None, "margin": float(found["elo"][2]) if found["elo"] else None,
        "penta": [int(v) for v in found["penta"][1].split(",")] if found["penta"] else None,
        "dev": found["dev"][1] if found["dev"] else None, "base": found["base"][1] if found["base"] else None,
        "state": "passed" if llr >= upper else "failed" if llr <= lower else "running",
    }


async def follow_openbench(url: str, tracker: Tracker) -> None:
    """An OpenBench test's SPRT, read off its page every little while. OpenBench adds up every worker's games, the
    PGN here is one worker's."""
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as session:
        while True:
            try:
                async with session.get(url) as response:
                    sprt = parse_openbench(await response.text()) if response.status == 200 else None
                    error = None if sprt else f"no SPRT on the page (HTTP {response.status})"
            except (aiohttp.ClientError, asyncio.TimeoutError) as failure:
                sprt, error = None, f"{type(failure).__name__}: {failure}"
            if error:
                print(f"bwawa: OpenBench {url}: {error}", file=sys.stderr)
            tracker.set_sprt({**(sprt or tracker.sprt or {}), "url": url, "error": error})
            await asyncio.sleep(OPENBENCH_SECONDS)


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
