# Traitors

A real-time social deduction party game. One host runs the game; everyone
else is a player. The host secretly appoints one player as the Traitor.
Each night the Traitor privately picks a victim, the host reveals it to
everyone, the group discusses, and then votes out who they suspect. The
Traitor wins by parity (traitors ≥ remaining players); the players win by
voting the Traitor out.

## Run it locally

```bash
cd traitors_game
pip install -r requirements.txt
uvicorn main:app --reload
```

Open `http://127.0.0.1:8000` in a few browser tabs (or on a few phones on
the same Wi-Fi, using your machine's local IP instead of 127.0.0.1) — one
tab is the host, the rest join with the room code.

## How a round works

1. **Host creates a room** → gets a 5-letter room code. Others join with it.
2. **Host starts the game** (needs 3+ non-host players) and privately picks
   the Traitor — nobody else is told who it is.
3. **Night**: only the Traitor sees a "choose a victim" screen. Everyone
   else just sees "night has fallen."
4. **Reveal**: the host taps to announce who was found dead.
5. **Discussion**: a simple chat panel for everyone to accuse and defend.
6. **Voting**: every alive player votes; majority is eliminated (ties break
   randomly). If it was the Traitor, players win. If not, the cycle repeats.

## Notes on the implementation

- Game state lives in memory (`ROOMS` dict in `main.py`). It resets if the
  server restarts, and won't work across multiple server processes/replicas
  — fine for a single small deployment, but swap in Redis if you need to
  scale horizontally.
- The host is a **moderator**, not one of the *n* players — they can't be
  killed, voted for, or become the Traitor themselves.
- The client (`static/`) reconnects automatically on page refresh using a
  `localStorage`-saved room code + player id.
- Only one Traitor is supported right now. Adding more (or special roles
  like a Detective/Doctor) mainly means: track a list of traitor ids instead
  of one, and adjust the private-messaging and win-condition logic.

## Deploying (e.g. Render)

1. Push this folder to a GitHub repo.
2. Create a new **Web Service** on Render, point it at the repo.
3. Build command: `pip install -r requirements.txt`
4. Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
