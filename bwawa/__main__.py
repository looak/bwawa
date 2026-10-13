"""bwawa, watch engine matches live.

    python -m bwawa --fastchess-log games.log [--pgn games.pgn] [--telemetry 9100] [--port 8080]
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from aiohttp import web

from .games import Tracker
from .server import create_app
from .sources import follow_fastchess_log, follow_pgn, listen_telemetry


def main() -> int:
    parser = argparse.ArgumentParser(prog="bwawa", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--fastchess-log", metavar="FILE",
                        help="a fastchess log written with -log file=FILE level=info engine=true realtime=true")
    parser.add_argument("--pgn", metavar="FILE", help="the runner's PGN output, for results & terminations")
    parser.add_argument("--telemetry", metavar="PORT", type=int,
                        help="listen for engine telemetry, JSON lines over UDP on this port")
    parser.add_argument("--host", default="127.0.0.1", help="web UI address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8080, help="web UI port (default 8080)")
    args = parser.parse_args()

    if not args.fastchess_log:
        parser.error("give a source, --fastchess-log")

    tracker = Tracker()
    app = create_app(tracker)

    async def start_sources(_: web.Application) -> None:
        tasks = [asyncio.create_task(follow_fastchess_log(args.fastchess_log, tracker))]
        if args.pgn:
            tasks.append(asyncio.create_task(follow_pgn(args.pgn, tracker)))
        if args.telemetry:
            await listen_telemetry(args.host, args.telemetry, tracker)
        app["sources"] = tasks

    app.on_startup.append(start_sources)
    print(f"bwawa on http://{args.host}:{args.port}", file=sys.stderr)
    web.run_app(app, host=args.host, port=args.port, print=None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
