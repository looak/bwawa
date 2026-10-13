# bwawa

*Swahili for waterhole, where the herd gathers.*

Watch chess engine matches live. A match runner plays many games at once, an SPRT, a gauntlet against other engines,
and their PVs scroll past too fast to read. bwawa follows the runner's log, rebuilds every game and shows them in the
browser: a grid of all games with the match statistics, and any single game with its board, eval graph, moves, clocks
and the engine's live search.

It reads plain UCI traffic, so it works with any engine. Engines can add data UCI can't carry over UDP, see
[PROTOCOL.md](PROTOCOL.md).

## Status

Early. The collector works: fastchess logs, PGN results and telemetry go in, games come out as JSON over HTTP and a
websocket. The web UI is next.

## Running

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # .venv/bin/pip on Linux
```

Run fastchess with engine logging, and its PGN for results:

```bash
fastchess ... -log file=games.log level=info engine=true realtime=true -pgnout file=games.pgn
```

Then point bwawa at them:

```bash
python -m bwawa --fastchess-log games.log --pgn games.pgn [--telemetry 9100] [--port 8080]
```

## Layout

| File | |
|:--|:--|
| `bwawa/events.py` | `EngineIO`, one UCI line between runner and engine. Every source produces these, `parse_fastchess_line` for fastchess logs |
| `bwawa/uci.py` | parsing of `position`, `go`, `info` and `bestmove` |
| `bwawa/games.py` | `Tracker`, turns events into games, one current game per runner slot. Results from PGN, telemetry matched by game key |
| `bwawa/sources.py` | follows a log or PGN as it grows, the UDP telemetry listener |
| `bwawa/server.py` | aiohttp: `/api/games`, `/api/game/{id}`, `/ws` pushes changes, serves `static/` |
| `bwawa/static/` | the web UI, plain HTML, CSS & JavaScript |

## License

GPL-3.0, see [LICENSE](LICENSE).
