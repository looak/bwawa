"""The web UI: the games as JSON, live updates over a websocket."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from aiohttp import WSMsgType, web

from .games import Game, Tracker
from .reference import Reference

STATIC = Path(__file__).parent / "static"
PUSH_SECONDS = 0.25


class Hub:
    """Pushes changed game summaries to every client, and the full game to clients watching one."""

    def __init__(self, tracker: Tracker, detail):
        self.tracker = tracker
        self.detail = detail
        self.clients: dict[web.WebSocketResponse, dict] = {}

    async def run(self) -> None:
        while True:
            await asyncio.sleep(PUSH_SECONDS)
            for socket, state in list(self.clients.items()):
                try:
                    await self.push(socket, state)
                except (ConnectionResetError, RuntimeError):
                    self.clients.pop(socket, None)

    async def push(self, socket: web.WebSocketResponse, state: dict) -> None:
        seen: dict[int, int] = state["seen"]
        changed = [game.summary() for game in self.tracker.games.values() if seen.get(game.id) != game.version]
        gone = [game_id for game_id in seen if game_id not in self.tracker.games]
        for game in self.tracker.games.values():
            seen[game.id] = game.version
        for game_id in gone:
            del seen[game_id]
        sprt_changed = state.get("sprtVersion") != self.tracker.sprt_version
        state["sprtVersion"] = self.tracker.sprt_version
        if changed or gone or sprt_changed:
            await socket.send_str(json.dumps({"type": "games", "games": changed, "gone": gone,
                                              "stats": self.tracker.stats()}))
        watched = self.tracker.games.get(state.get("watch") or -1)
        if watched is not None and state.get("watchVersion") != watched.version:
            state["watchVersion"] = watched.version
            await socket.send_str(json.dumps({"type": "game", "game": self.detail(watched)}))


def create_app(tracker: Tracker, reference: Reference | None = None) -> web.Application:
    def detail(game: Game) -> dict:
        data = game.detail()
        if reference is not None:
            data["reference"] = reference.view(game)
        return data

    hub = Hub(tracker, detail)
    app = web.Application()
    if reference is not None:
        reference.watching = lambda: {state["watch"] for state in hub.clients.values() if state["watch"] is not None}

    async def index(_: web.Request) -> web.FileResponse:
        return web.FileResponse(STATIC / "index.html")

    async def games(_: web.Request) -> web.Response:
        return web.json_response({"games": tracker.summaries(), "stats": tracker.stats()})

    async def game(request: web.Request) -> web.Response:
        found = tracker.games.get(int(request.match_info["game_id"]))
        if found is None:
            raise web.HTTPNotFound()
        return web.json_response(detail(found))

    async def sprt(_: web.Request) -> web.Response:
        return web.json_response(tracker.sprt_report())

    async def websocket(request: web.Request) -> web.WebSocketResponse:
        socket = web.WebSocketResponse(heartbeat=20)
        await socket.prepare(request)
        state: dict = {"seen": {}, "watch": None, "watchVersion": None}
        hub.clients[socket] = state
        try:
            async for message in socket:
                if message.type != WSMsgType.TEXT:
                    continue
                try:
                    command = json.loads(message.data)
                except json.JSONDecodeError:
                    continue
                if "watch" in command:
                    state["watch"] = command["watch"]
                    state["watchVersion"] = None
                if "analyze" in command and reference is not None:
                    reference.request(command["analyze"])
        finally:
            hub.clients.pop(socket, None)
        return socket

    async def start_hub(app: web.Application) -> None:
        app["hub"] = asyncio.create_task(hub.run())
        if reference is not None:
            app["reference"] = asyncio.create_task(reference.run())

    async def stop_reference(app: web.Application) -> None:
        if "reference" in app:
            app["reference"].cancel()
            await asyncio.gather(app["reference"], return_exceptions=True)

    app.router.add_get("/", index)
    app.router.add_get("/api/games", games)
    app.router.add_get("/api/game/{game_id}", game)
    app.router.add_get("/api/sprt", sprt)
    app.router.add_get("/ws", websocket)
    app.router.add_static("/static", STATIC)
    app.on_startup.append(start_hub)
    app.on_cleanup.append(stop_reference)
    return app
