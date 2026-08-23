"""
Traitors — a social deduction party game.

Flow:
  LOBBY -> creator starts the game -> the COMPUTER instantly and randomly
           picks the Traitor from everyone in the room, in secret
  -> NIGHT (traitor privately picks a victim + a crime location)
  -> the kill reveals automatically the moment the Traitor confirms it
     (no human host/moderator exists in this version — every player is
     an equal participant)
  -> INVESTIGATION (everyone gets a secret real location for the night,
     submits a public alibi claim — true or false — and may spend one
     Inspect on another player for a clue; the Traitor may Sabotage one
     player instead, to make inspections of them come back clean). This
     phase auto-advances to Discussion the moment every alive player has
     submitted their alibi.
  -> DISCUSSION (the Evidence Board is revealed: crime location + everyone's
     public alibi claims, side by side; each player also still has whatever
     private inspection results they personally collected). Every alive
     player taps "Ready to Move On"; once all have, Voting begins.
  -> VOTING (everyone votes, majority eliminated; tallies automatically
     once every alive player has voted)
  -> back to NIGHT, or GAME_OVER

Nobody chooses to "be the host" when they join — everyone just creates or
joins a room as an equal, and stays an equal, playable participant for the
whole game. The room's creator only has one bit of extra power: they can
tap "Seal the Circle" to start the game (and "Play Again" to start a
rematch) — beyond that they're just as likely as anyone to be drawn as the
Traitor.

The Investigation System is designed to create suspicion, not certainty:
a clue can point at the Traitor, but it is never proof by itself — Sabotage
can launder a dirty result, and an innocent player can simply have been
assigned the same location as the crime by chance. Players have to compare
notes out loud to build a case.

Each player also picks a character (a portrait id) when they join — purely
cosmetic, used for their avatar and the elimination animation.

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
# start. There's no host set aside anymore, so this is purely "how many
# players make for a good round" — feel free to lower it.
MIN_PLAYERS_TO_START = 4

# Rooms/locations used for the alibi & investigation system. Names are
# deliberately in the "old manor" flavor of the rest of the game.
LOCATIONS = [
    "the Library",
    "the Wine Cellar",
    "the Garden",
    "the Study",
    "the Chapel",
    "the Kitchen",
]


# ---------------------------------------------------------------------------
# In-memory data model
# ---------------------------------------------------------------------------

class Player:
    def __init__(self, player_id: str, name: str, character: str = "c1"):
        self.id = player_id
        self.name = name
        self.character = character  # cosmetic portrait id, e.g. "c1"
        self.alive = True
        self.connected = True

    def public(self):
        return {
            "id": self.id,
            "name": self.name,
            "character": self.character,
            "alive": self.alive,
            "connected": self.connected,
        }


class Room:
    def __init__(self, code: str, creator_id: str):
        self.code = code
        self.creator_id = creator_id  # only used to permit starting the game / rematch
        self.players: dict[str, Player] = {}
        self.connections: dict[str, WebSocket] = {}
        self.phase = "LOBBY"  # LOBBY, NIGHT, INVESTIGATION, DISCUSSION, VOTING, GAME_OVER
        self.traitor_id: Optional[str] = None
        self.victim_id: Optional[str] = None
        self.votes: dict[str, str] = {}  # voter_id -> target_id
        self.round_num = 1
        self.winner: Optional[str] = None
        self.log: list[str] = []

        # ---- Scoreboard: persists across "Play Again" rematches in this room ----
        self.scoreboard: dict[str, dict] = {}  # pid -> {name, games_played, wins, times_traitor, traitor_wins}

        # ---- Investigation System (reset each round) ----
        self.crime_location: Optional[str] = None
        self.true_activities: dict[str, str] = {}   # pid -> real secret location that round
        self.alibi_claims: dict[str, str] = {}       # pid -> location they publicly claimed
        self.has_inspected: dict[str, bool] = {}      # pid -> used their one Inspect this round
        self.sabotage_target: Optional[str] = None    # who the Traitor protected this round
        self.sabotage_available: bool = True
        self.evidence_board: Optional[dict] = None     # populated once DISCUSSION begins

        # ---- Discussion readiness (reset each round) ----
        self.discussion_ready: set[str] = set()

    # ---- helpers -----------------------------------------------------

    def alive_players(self):
        """Every alive player is a full participant — there's no separate
        moderator role in this version."""
        return [p for p in self.players.values() if p.alive]

    def add_log(self, msg: str):
        self.log.append(msg)

    def reset_round_investigation_state(self):
        self.true_activities = {}
        self.alibi_claims = {}
        self.has_inspected = {}
        self.sabotage_target = None
        self.sabotage_available = True
        self.evidence_board = None
        self.discussion_ready = set()

    def scoreboard_entry(self, pid: str) -> dict:
        return self.scoreboard.setdefault(pid, {
            "name": self.players[pid].name,
            "games_played": 0,
            "wins": 0,
            "times_traitor": 0,
            "traitor_wins": 0,
        })

    def record_game_result(self):
        """Called once, right when self.winner is set. Every player gets
        credit for a game played; the Traitor and the innocents split the
        win depending on who came out on top."""
        for pid, p in self.players.items():
            entry = self.scoreboard_entry(pid)
            entry["name"] = p.name  # keep display name current
            entry["games_played"] += 1
            is_traitor = pid == self.traitor_id
            if is_traitor:
                entry["times_traitor"] += 1
            won = (self.winner == "traitor" and is_traitor) or (self.winner == "players" and not is_traitor)
            if won:
                entry["wins"] += 1
                if is_traitor:
                    entry["traitor_wins"] += 1

    def scoreboard_list(self):
        return sorted(
            self.scoreboard.values(),
            key=lambda e: (-e["wins"], -e["games_played"], e["name"].lower()),
        )

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

    def state_for(self, viewer_id: Optional[str] = None):
        """Same shared state for everyone, plus a few fields personalized to
        the viewer (their own alibi/inspection progress) so the UI stays in
        sync even across reconnects, without leaking who did what to anyone
        else."""
        return {
            "type": "state",
            "room_code": self.code,
            "phase": self.phase,
            "round": self.round_num,
            "creator_id": self.creator_id,
            "players": [p.public() for p in self.players.values()],
            "victim_name": self.players[self.victim_id].name if self.victim_id and self.victim_id in self.players else None,
            "winner": self.winner,
            "log": self.log[-15:],
            "votes_in": len(self.votes),
            "alive_count": len(self.alive_players()),
            # Investigation System — shared
            "crime_location": self.crime_location,
            "alibi_submitted_ids": list(self.alibi_claims.keys()),
            "investigations_used": sum(1 for v in self.has_inspected.values() if v),
            "sabotage_available": self.sabotage_available,
            "evidence_board": self.evidence_board,
            # Discussion readiness
            "discussion_ready_ids": list(self.discussion_ready),
            # Scoreboard (persists across rematches in this room)
            "scoreboard": self.scoreboard_list(),
            # Investigation System — personalized to the viewer
            "my_true_location": self.true_activities.get(viewer_id) if viewer_id else None,
            "my_alibi_submitted": bool(viewer_id and viewer_id in self.alibi_claims),
            "my_has_inspected": bool(viewer_id and self.has_inspected.get(viewer_id, False)),
        }

    async def broadcast_state(self):
        for pid, ws in list(self.connections.items()):
            try:
                await ws.send_json(self.state_for(pid))
            except Exception:
                pass


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
    character: str = "c1"


class JoinRoomBody(BaseModel):
    room_code: str
    name: str
    character: str = "c1"


@app.post("/api/create_room")
def create_room(body: CreateRoomBody):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name required")
    code = gen_room_code()
    creator_id = new_player_id()
    room = Room(code, creator_id)
    room.players[creator_id] = Player(creator_id, name, character=body.character)
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
    room.players[pid] = Player(pid, name, character=body.character)
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


def compute_clue(room: Room, target_id: str) -> str:
    """The heart of the Investigation System: tiered, ambiguous clues.

    A clue can point at the Traitor, but it is never proof by itself —
    Sabotage can launder a dirty result, and an innocent player can simply
    have been assigned the same location as the crime by chance.
    """
    if room.sabotage_target == target_id:
        return "🟢 No irregularities found — this person's story checks out."

    true_loc = room.true_activities.get(target_id)
    claimed_loc = room.alibi_claims.get(target_id)
    at_crime_scene = true_loc is not None and true_loc == room.crime_location
    is_lying = claimed_loc is not None and claimed_loc != true_loc

    if at_crime_scene:
        return "🔴 Strong clue: this person's real whereabouts match the crime scene."
    if is_lying:
        return "🟡 Medium clue: this person's claimed alibi doesn't match what really happened."
    return "🟢 No irregularities found — this person's story checks out."


async def begin_investigation(room: Room):
    """Called right after the kill is revealed. Assigns everyone's secret
    real location for the night (the Traitor's is already the crime scene)
    and privately tells each alive player their own true activity."""
    room.reset_round_investigation_state()
    room.true_activities[room.traitor_id] = room.crime_location

    for p in room.alive_players():
        if p.id == room.traitor_id:
            continue
        room.true_activities[p.id] = random.choice(LOCATIONS)

    room.phase = "INVESTIGATION"
    room.add_log("Everyone quietly recalls where they really were last night.")

    for p in room.alive_players():
        await room.send_to(p.id, {
            "type": "investigation_start",
            "your_location": room.true_activities[p.id],
            "locations": LOCATIONS,
            "crime_location": room.crime_location,
        })


def build_evidence_board(room: Room):
    alibis = [
        {
            "id": p.id,
            "name": p.name,
            "location": room.alibi_claims.get(p.id, "No alibi given"),
        }
        for p in room.alive_players()
    ]
    room.evidence_board = {
        "crime_location": room.crime_location,
        "alibis": alibis,
    }


async def tally_votes(room: Room):
    if not room.votes:
        room.add_log("No votes were cast — no one is eliminated.")
        room.phase = "NIGHT"
        room.victim_id = None
        room.crime_location = None
        room.evidence_board = None
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
        room.record_game_result()
    else:
        room.phase = "NIGHT"
        room.victim_id = None
        room.crime_location = None
        room.evidence_board = None
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
            is_creator = player_id == room.creator_id

            # ---- CREATOR: start the game -> COMPUTER instantly draws the Traitor ----
            if mtype == "start_game":
                if room.phase != "LOBBY":
                    await room.send_to(player_id, {"type": "error", "message": "The game has already started."})
                    continue
                if not is_creator:
                    await room.send_to(player_id, {"type": "error", "message": "Only the room's creator can start the game."})
                    continue
                if len(room.players) < MIN_PLAYERS_TO_START:
                    await room.send_to(player_id, {
                        "type": "error",
                        "message": f"Need at least {MIN_PLAYERS_TO_START} players to start.",
                    })
                    continue

                traitor_id = random.choice(list(room.players.keys()))
                room.traitor_id = traitor_id
                room.phase = "NIGHT"
                room.add_log("Roles have been assigned in secret.")

                await room.broadcast({"type": "roles_assigned"})
                await room.broadcast_state()
                for pid in room.players:
                    is_t = pid == traitor_id
                    payload = {"type": "you_are_traitor", "is_traitor": is_t}
                    if is_t:
                        payload["locations"] = LOCATIONS
                    await room.send_to(pid, payload)

            # ---- TRAITOR: picks a victim + crime location during NIGHT; kill reveals instantly ----
            elif mtype == "traitor_kill" and player_id == room.traitor_id and room.phase == "NIGHT":
                target_id = msg.get("target_id")
                location = msg.get("location")
                target = room.players.get(target_id)
                if not target or not target.alive or target_id == room.traitor_id:
                    await room.send_to(player_id, {"type": "error", "message": "Invalid target."})
                    continue
                if location not in LOCATIONS:
                    await room.send_to(player_id, {"type": "error", "message": "Invalid location."})
                    continue

                room.victim_id = target_id
                room.crime_location = location
                target.alive = False
                room.add_log(f"{target.name} was found dead in {location}.")

                winner = check_win_condition(room)
                await room.broadcast({
                    "type": "night_reveal",
                    "victim_id": target_id,
                    "victim_name": target.name,
                    "crime_location": location,
                })

                if winner:
                    room.phase = "GAME_OVER"
                    room.winner = winner
                    room.add_log(f"Game over — {'the Traitor wins!' if winner == 'traitor' else 'the Players win!'}")
                    room.record_game_result()
                    await room.broadcast_state()
                else:
                    await begin_investigation(room)
                    await room.broadcast_state()

            # ---- Any alive player (incl. Traitor): submit a public alibi claim.
            # Auto-advances to Discussion once everyone alive has submitted one. ----
            elif mtype == "submit_alibi" and room.phase == "INVESTIGATION":
                player = room.players.get(player_id)
                location = msg.get("location")
                if not player or not player.alive:
                    continue
                if location not in LOCATIONS:
                    await room.send_to(player_id, {"type": "error", "message": "Invalid location."})
                    continue
                if player_id in room.alibi_claims:
                    continue
                room.alibi_claims[player_id] = location

                if len(room.alibi_claims) >= len(room.alive_players()):
                    build_evidence_board(room)
                    room.phase = "DISCUSSION"
                    room.add_log("The Evidence Board has been revealed.")

                await room.broadcast_state()

            # ---- Any non-Traitor alive player: spend their one Inspect ----
            elif mtype == "inspect" and room.phase == "INVESTIGATION" and player_id != room.traitor_id:
                player = room.players.get(player_id)
                target_id = msg.get("target_id")
                if not player or not player.alive:
                    continue
                if room.has_inspected.get(player_id):
                    continue
                target = room.players.get(target_id)
                if not target or not target.alive or target_id == player_id:
                    await room.send_to(player_id, {"type": "error", "message": "Invalid inspection target."})
                    continue
                room.has_inspected[player_id] = True
                clue = compute_clue(room, target_id)
                await room.send_to(player_id, {
                    "type": "inspect_result",
                    "target_id": target_id,
                    "target_name": target.name,
                    "clue": clue,
                })
                await room.broadcast_state()

            # ---- TRAITOR: spend their one Sabotage, protecting a player from inspection ----
            elif mtype == "sabotage" and room.phase == "INVESTIGATION" and player_id == room.traitor_id:
                if not room.sabotage_available:
                    continue
                target_id = msg.get("target_id")
                target = room.players.get(target_id)
                if not target or not target.alive or target_id == room.traitor_id:
                    await room.send_to(player_id, {"type": "error", "message": "Invalid sabotage target."})
                    continue
                room.sabotage_target = target_id
                room.sabotage_available = False
                await room.send_to(player_id, {
                    "type": "sabotage_confirmed",
                    "target_name": target.name,
                })
                await room.broadcast_state()

            # ---- Any alive player: mark themselves ready to leave Discussion.
            # Once every alive player is ready, Voting begins automatically. ----
            elif mtype == "end_discussion_ready" and room.phase == "DISCUSSION":
                player = room.players.get(player_id)
                if not player or not player.alive:
                    continue
                room.discussion_ready.add(player_id)

                if len(room.discussion_ready) >= len(room.alive_players()):
                    room.phase = "VOTING"
                    room.votes = {}
                    room.add_log("Voting has begun.")

                await room.broadcast_state()

            # ---- Any alive player: cast a vote ----
            elif mtype == "cast_vote" and room.phase == "VOTING":
                voter = room.players.get(player_id)
                target_id = msg.get("target_id")
                if not voter or not voter.alive or target_id not in room.players:
                    continue
                target = room.players[target_id]
                if not target.alive:
                    continue
                room.votes[player_id] = target_id
                await room.broadcast_state()
                if len(room.votes) >= len(room.alive_players()):
                    await tally_votes(room)

            # ---- CREATOR: rematch — reset the room to LOBBY, keeping everyone
            # and the scoreboard, ready for a fresh random Traitor draw ----
            elif mtype == "play_again" and is_creator and room.phase == "GAME_OVER":
                for p in room.players.values():
                    p.alive = True
                room.phase = "LOBBY"
                room.traitor_id = None
                room.victim_id = None
                room.votes = {}
                room.round_num = 1
                room.winner = None
                room.log = []
                room.reset_round_investigation_state()
                room.add_log("A new game begins.")
                await room.broadcast_state()

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