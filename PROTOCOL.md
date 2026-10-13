# bwawa telemetry protocol, v1

Engines can report what UCI can't carry, eval details, thread & transposition table statistics, time management
decisions, straight to bwawa. This is the contract between an engine and bwawa's collector. It's optional: bwawa
works from the match runner's log alone, telemetry adds to it.

## Transport

- **UDP**, one datagram per report, sent without waiting for anything. Nobody listening is fine, the datagram is
  dropped. An engine must never block, retry or slow its search for telemetry.
- **Enabled by the environment**, e.g. `ELEPHANT_TELEMETRY=127.0.0.1:9100` for Elephant. Each engine picks its own
  variable name. Unset means no telemetry and no cost. The match runner (fastchess, cutechess, the OpenBench client)
  passes its environment on to the engines, no runner or UCI changes are needed.
- **Payload**: UTF-8 JSON, one object per line. A datagram may hold several lines. Keep a datagram under 8 KB,
  under 1400 bytes when possible.
- bwawa listens with `--telemetry PORT`.

## Common fields

Every report has these:

| Field | Type | Meaning |
|:--|:--|:--|
| `v` | int | protocol version, `1` |
| `type` | string | `hello`, `go`, `iteration` or `search`, see below |
| `engine` | string | the engine's UCI `id name` |
| `pid` | int | the engine's process id, tells apart two instances of the same engine |
| `t` | int | milliseconds since the engine started, monotonic |
| `fen` | string | the start position of the last `position` command, `startpos` or a FEN |
| `moves` | [string] | the moves of the last `position` command, UCI notation, `[]` for none |
| `search` | int | counts `go` commands since the engine started, ties a search's reports together |

`fen` + `moves` is the **game key**: bwawa matches a report to the live game whose current position the runner sent
with exactly that `position` command. `hello` has no game key.

## Report types

### `hello`, when telemetry starts
| Field | Type | Meaning |
|:--|:--|:--|
| `version` | string | engine version |
| `threads` | int | `Threads` option |
| `hash` | int | `Hash` option, MB |

Also sent again when `Threads` or `Hash` change.

### `go`, when a search starts
| Field | Type | Meaning |
|:--|:--|:--|
| `limits` | object | the `go` parameters as given, e.g. `{"wtime": 8000, "btime": 7900, "winc": 80, "binc": 80}` |
| `soft_ms` | int | time the engine plans to use, optional |
| `hard_ms` | int | time after which the engine aborts the search, optional |

### `iteration`, every completed iteration of every search thread
| Field | Type | Meaning |
|:--|:--|:--|
| `thread` | int | `0` is the main thread |
| `depth` | int | |
| `seldepth` | int | optional |
| `cp` / `mate` | int | score, side to move's view, one of the two |
| `nodes` | int | this thread's nodes |
| `ms` | int | since the search started |
| `pv` | [string] | UCI moves |

### `search`, when a search ends, right before `bestmove`
| Field | Type | Meaning |
|:--|:--|:--|
| `bestmove` | string | UCI move |
| `depth` | int | the main thread's last completed depth |
| `cp` / `mate` | int | score, side to move's view |
| `nodes` | int | all threads |
| `ms` | int | time used |
| `stop` | string | why it stopped: `time`, `depth`, `nodes`, `mate`, `stop` (the GUI said so) |
| `threads` | [object] | per thread, `{"id": 0, "depth": 14, "nodes": 123456}` |
| `tt` | object | optional, e.g. `{"hashfull": 312, "probes": 1000000, "hits": 420000}` |
| `extra` | object | optional, anything engine specific, bwawa shows it as is |

## Rules for both sides

- Unknown `type`s and fields are ignored by bwawa, engines can add fields without a protocol change. A field that
  changes meaning needs a new `v`.
- Every field except the common ones is optional, bwawa shows what arrives.
- Reports can arrive out of order or not at all, it's UDP. bwawa never relies on one.

## Example

```json
{"v":1,"type":"iteration","engine":"Elephant Gambit 1.0.0","pid":4242,"t":81234,"fen":"startpos","moves":["e2e4","e7e5"],"search":7,"thread":2,"depth":13,"cp":18,"nodes":241020,"ms":412,"pv":["g1f3","b8c6","f1b5"]}
```
