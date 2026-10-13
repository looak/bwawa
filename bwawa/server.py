"""The web UI: the games as JSON, live updates over a websocket."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from aiohttp import WSMsgType, web

from .games import Tracker

STATIC = Path(__file__).parent / "static"
PUSH_SECONDS = 0.25


class Hub:
    """Pushes changed game summaries to every client, and the full game to clients watching one."""

    def __init__(self, tracker: Tracker):
        self.tracker = tracker
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
        if changed or gone:
            await socket.send_str(json.dumps({"type": "games", "games": changed, "gone": gone,
                                              "stats": self.tracker.stats()}))
        watched = self.tracker.games.get(state.get("watch") or -1)
        if watched is not None and state.get("watchVersion") != watched.version:
            state["watchVersion"] = watched.version
            await socket.send_str(json.dumps({"type": "game", "game": watched.detail()}))


def create_app(tracker: Tracker) -> web.Application:
    hub = Hub(tracker)
    app = web.Application()

    async def index(_: web.Request) -> web.FileResponse:
        return web.FileResponse(STATIC / "index.html")

    async def games(_: web.Request) -> web.Response:
        return web.json_response({"games": tracker.summaries(), "stats": tracker.stats()})

    async def game(request: web.Request) -> web.Response:
        found = tracker.games.get(int(request.match_info["game_id"]))
        if found is None:
            raise web.HTTPNotFound()
        return web.json_response(found.detail())

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
        finally:
            hub.clients.pop(socket, None)
        return socket

    async def start_hub(app: web.Application) -> None:
        app["hub"] = asyncio.create_task(hub.run())

    app.router.add_get("/", index)
    app.router.add_get("/api/games", games)
    app.router.add_get("/api/game/{game_id}", game)
    app.router.add_get("/ws", websocket)
    app.router.add_static("/static", STATIC)
    app.on_startup.append(start_hub)
    return app
