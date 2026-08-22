
"""
Traitors — a social deduction party game.
 
Flow:
  LOBBY -> creator starts the game -> server randomly picks a HOST from
           everyone in the room -> host picks the traitor (SELECT_TRAITOR)
  -> NIGHT (traitor privately picks a victim)
  -> REVEAL (victim announced to everyone)
  -> DISCUSSION (host-controlled timer/phase, everyone talks)
  -> VOTING (everyone votes, majority eliminated)
  -> back to NIGHT, or GAME_OVER
 
Nobody chooses to "be the host" when they join — everyone just creates or
joins a room as an equal. Once enough people are in the lobby, the person
who created the room starts the game, and the server randomly draws one
player to be that round's host/moderator. The host then privately picks
the Traitor. This keeps host duties from being a role people fight over or
predict, and it's re-drawn fresh every time a new game starts in the room.
 
State is kept in memory per room. Swap `ROOMS` for Redis if you ever
need multiple server processes / persistence.
"""
 
import random
import string
import uuid
from typing import Optional
 
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
 
app = FastAPI(title="Traitors Game")
 
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
 
# Minimum number of people who must be in the room before the game can
# start. One of them will be drawn as host, so this guarantees at least
# 3 real players remain once the host is set aside.
MIN_PLAYERS_TO_START = 4
 
 
# ---------------------------------------------------------------------------
# In-memory data model
# ---------------------------------------------------------------------------
 
class Player:
    def __init__(self, player_id: str, name: str):
        self.id = player_id
        self.name = name
        self.is_host = False  # decided randomly when the game starts
        self.alive = True
        self.connected = True
 
    def public(self):
        return {
            "id": self.id,
            "name": self.name,
            "is_host": self.is_host,
            "alive": self.alive,
            "connected": self.connected,
        }
 
 
class Room:
    def __init__(self, code: str, creator_id: str):
        self.code = code
        self.creator_id = creator_id  # only used to permit starting the game
        self.players: dict[str, Player] = {}
        self.connections: dict[str, WebSocket] = {}
        self.phase = "LOBBY"  # LOBBY, SELECT_TRAITOR, NIGHT, REVEAL, DISCUSSION, VOTING, GAME_OVER
        self.host_id: Optional[str] = None  # randomly drawn once the game starts
        self.traitor_id: Optional[str] = None
        self.victim_id: Optional[str] = None
        self.votes: dict[str, str] = {}  # voter_id -> target_id
        self.round_num = 1
        self.winner: Optional[str] = None
        self.log: list[str] = []
 
    # ---- helpers -----------------------------------------------------
 
    def alive_players(self):
        """Alive PLAYERS only — the host is a moderator, not one of the n players."""
        return [p for p in self.players.values() if p.alive and not p.is_host]
 
    def add_log(self, msg: str):
        self.log.append(msg)
 
    async def broadcast(self, message: dict, exclude: Optional[str] = None):
        for pid, ws in list(self.connections.items()):
            if pid == exclude:
                continue
            try:
                await ws.send_json(message)
            except Exception:
                pass
 
    async def send_to(self, player_id: str, message: dict):
        ws = self.connections.get(player_id)
        if ws:
            try:
                await ws.send_json(message)
            except Exception:
                pass
 
    def public_state(self):
        host = self.players.get(self.host_id) if self.host_id else None
        return {
            "type": "state",
            "room_code": self.code,
            "phase": self.phase,
            "round": self.round_num,
            "host_id": self.host_id,
            "host_name": host.name if host else None,
            "players": [p.public() for p in self.players.values()],
            "victim_name": self.players[self.victim_id].name if self.victim_id and self.victim_id in self.players else None,
            "winner": self.winner,
            "log": self.log[-15:],
            "votes_in": len(self.votes),
            "alive_count": len(self.alive_players()),
        }
 
    async def broadcast_state(self):
        await self.broadcast(self.public_state())
 
 
ROOMS: dict[str, Room] = {}
 
 
def gen_room_code() -> str:
    while True:
        code = "".join(random.choices(string.ascii_uppercase, k=5))
        if code not in ROOMS:
            return code
 
 
def new_player_id() -> str:
    return uuid.uuid4().hex[:12]
 
 
# ---------------------------------------------------------------------------
# REST endpoints — create / join a room
# ---------------------------------------------------------------------------
 
class CreateRoomBody(BaseModel):
    name: str
 
 
class JoinRoomBody(BaseModel):
    room_code: str
    name: str
 
 
@app.post("/api/create_room")
def create_room(body: CreateRoomBody):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name required")
    code = gen_room_code()
    creator_id = new_player_id()
    room = Room(code, creator_id)
    room.players[creator_id] = Player(creator_id, name)
    ROOMS[code] = room
    return {"room_code": code, "player_id": creator_id, "is_creator": True}
 
 
@app.post("/api/join_room")
def join_room(body: JoinRoomBody):
    code = body.room_code.strip().upper()
    name = body.name.strip()
    room = ROOMS.get(code)
    if not room:
        raise HTTPException(404, "Room not found")
    if room.phase != "LOBBY":
        raise HTTPException(400, "Game already in progress")
    if not name:
        raise HTTPException(400, "Name required")
    if any(p.name.lower() == name.lower() for p in room.players.values()):
        raise HTTPException(400, "Name already taken in this room")
    pid = new_player_id()
    room.players[pid] = Player(pid, name)
    return {"room_code": code, "player_id": pid, "is_creator": False}
 
 
# ---------------------------------------------------------------------------
# Game logic helpers
# ---------------------------------------------------------------------------
 
def check_win_condition(room: Room) -> Optional[str]:
    """Returns 'traitor' or 'players' if the game has ended, else None."""
    alive = room.alive_players()
    traitor_alive = any(p.id == room.traitor_id and p.alive for p in room.players.values())
    if not traitor_alive:
        return "players"
    non_traitors_alive = len([p for p in alive if p.id != room.traitor_id])
    traitors_alive = len([p for p in alive if p.id == room.traitor_id])
    if traitors_alive >= non_traitors_alive:
        return "traitor"
    return None
 
 
async def tally_votes(room: Room):
    if not room.votes:
        room.add_log("No votes were cast — no one is eliminated.")
        room.phase = "NIGHT"
        room.victim_id = None
        room.round_num += 1
        await room.broadcast_state()
        return
 
    counts: dict[str, int] = {}
    for target in room.votes.values():
        counts[target] = counts.get(target, 0) + 1
    max_votes = max(counts.values())
    top = [pid for pid, c in counts.items() if c == max_votes]
    eliminated_id = random.choice(top)  # tie -> random among top
 
    eliminated = room.players[eliminated_id]
    eliminated.alive = False
    was_traitor = eliminated_id == room.traitor_id
 
    room.add_log(
        f"{eliminated.name} was voted out ({max_votes} vote{'s' if max_votes != 1 else ''}) — "
        f"{'the Traitor!' if was_traitor else 'not the Traitor.'}"
    )
 
    await room.broadcast({
        "type": "vote_result",
        "eliminated_id": eliminated_id,
        "eliminated_name": eliminated.name,
        "was_traitor": was_traitor,
        "vote_counts": {room.players[pid].name: c for pid, c in counts.items()},
    })
 
    room.votes = {}
    winner = check_win_condition(room)
    if winner:
        room.phase = "GAME_OVER"
        room.winner = winner
        room.add_log(f"Game over — {'the Traitor wins!' if winner == 'traitor' else 'the Players win!'}")
    else:
        room.phase = "NIGHT"
        room.victim_id = None
        room.round_num += 1
 
    await room.broadcast_state()
 
 
# ---------------------------------------------------------------------------
# WebSocket endpoint — all real-time game actions
# ---------------------------------------------------------------------------
 
@app.websocket("/ws/{room_code}/{player_id}")
async def ws_endpoint(websocket: WebSocket, room_code: str, player_id: str):
    room = ROOMS.get(room_code.upper())
    if not room or player_id not in room.players:
        await websocket.close(code=4004)
        return
 
    await websocket.accept()
    room.connections[player_id] = websocket
    room.players[player_id].connected = True
    await room.broadcast_state()
 
    try:
        while True:
            msg = await websocket.receive_json()
            mtype = msg.get("type")
 
            # These are re-checked on every message because host_id is only
            # assigned once the game starts — it isn't fixed at connect time.
            is_creator = player_id == room.creator_id
            is_current_host = room.host_id is not None and player_id == room.host_id
 
            # ---- CREATOR: start the game, move LOBBY -> host draw -> SELECT_TRAITOR ----
            if mtype == "start_game" and is_creator and room.phase == "LOBBY":
                total_players = len(room.players)
                if total_players < MIN_PLAYERS_TO_START:
                    await room.send_to(player_id, {
                        "type": "error",
                        "message": f"Need at least {MIN_PLAYERS_TO_START} players (one is drawn as host).",
                    })
                    continue
 
                # Draw the host at random from everyone in the room.
                host_id = random.choice(list(room.players.keys()))
                room.host_id = host_id
                for pid, p in room.players.items():
                    p.is_host = (pid == host_id)
 
                host_player = room.players[host_id]
                room.phase = "SELECT_TRAITOR"
                room.add_log(f"{host_player.name} was drawn to host this game.")
 
                await room.broadcast({
                    "type": "host_announcement",
                    "host_id": host_id,
                    "host_name": host_player.name,
                })
                await room.broadcast_state()
                await room.send_to(host_id, {
                    "type": "choose_traitor_prompt",
                    "players": [p.public() for p in room.players.values() if p.id != host_id],
                })
 
            # ---- HOST: picks who the traitor is ----
            elif mtype == "select_traitor" and is_current_host and room.phase == "SELECT_TRAITOR":
                target_id = msg.get("target_id")
                if target_id not in room.players or room.players[target_id].is_host:
                    continue
                room.traitor_id = target_id
                room.phase = "NIGHT"
                room.add_log("The Traitor has been chosen in secret.")
                await room.send_to(target_id, {"type": "you_are_traitor", "is_traitor": True})
                for pid in room.players:
                    if pid != target_id:
                        await room.send_to(pid, {"type": "you_are_traitor", "is_traitor": False})
                await room.broadcast_state()
 
            # ---- TRAITOR: picks a victim during NIGHT ----
            elif mtype == "traitor_kill" and player_id == room.traitor_id and room.phase == "NIGHT":
                target_id = msg.get("target_id")
                target = room.players.get(target_id)
                if not target or not target.alive or target.is_host or target_id == room.traitor_id:
                    await room.send_to(player_id, {"type": "error", "message": "Invalid target."})
                    continue
                room.victim_id = target_id
                room.phase = "REVEAL"
                await room.send_to(room.host_id, {
                    "type": "host_kill_notice",
                    "victim_id": target_id,
                    "victim_name": target.name,
                })
                await room.broadcast_state()
 
            # ---- HOST: reveal the kill to everyone ----
            elif mtype == "reveal_kill" and is_current_host and room.phase == "REVEAL":
                victim = room.players.get(room.victim_id)
                if victim:
                    victim.alive = False
                    room.add_log(f"{victim.name} was found dead this morning.")
                    winner = check_win_condition(room)
                    await room.broadcast({
                        "type": "night_reveal",
                        "victim_id": victim.id,
                        "victim_name": victim.name,
                    })
                    if winner:
                        room.phase = "GAME_OVER"
                        room.winner = winner
                        room.add_log(f"Game over — {'the Traitor wins!' if winner == 'traitor' else 'the Players win!'}")
                    else:
                        room.phase = "DISCUSSION"
                await room.broadcast_state()
 
            # ---- HOST: move DISCUSSION -> VOTING ----
            elif mtype == "start_voting" and is_current_host and room.phase == "DISCUSSION":
                room.phase = "VOTING"
                room.votes = {}
                room.add_log("Voting has begun.")
                await room.broadcast_state()
 
            # ---- Any alive player: cast a vote ----
            elif mtype == "cast_vote" and room.phase == "VOTING":
                voter = room.players.get(player_id)
                target_id = msg.get("target_id")
                if not voter or voter.is_host or not voter.alive or target_id not in room.players:
                    continue
                target = room.players[target_id]
                if not target.alive or target.is_host:
                    continue
                room.votes[player_id] = target_id
                await room.broadcast_state()
                if len(room.votes) >= len(room.alive_players()):
                    await tally_votes(room)
 
            # ---- HOST: force-tally votes early ----
            elif mtype == "force_tally" and is_current_host and room.phase == "VOTING":
                await tally_votes(room)
 
            # ---- Simple chat, broadcast to room ----
            elif mtype == "chat":
                text = str(msg.get("text", ""))[:500].strip()
                if text:
                    sender = room.players[player_id]
                    await room.broadcast({"type": "chat", "from": sender.name, "text": text})
 
            else:
                await room.send_to(player_id, {"type": "error", "message": f"Can't do '{mtype}' right now."})
 
    except WebSocketDisconnect:
        room.players[player_id].connected = False
        room.connections.pop(player_id, None)
        await room.broadcast_state()
 
 
# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------
 
app.mount("/static", StaticFiles(directory="static"), name="static")
 
 
@app.get("/")
def index():
    return FileResponse("static/index.html")