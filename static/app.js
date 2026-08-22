// ---------------------------------------------------------------------------
// Traitors — client
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

let ws = null;
let me = { roomCode: null, playerId: null, name: null, isCreator: false, isTraitor: null };
let state = null; // last "state" message from server
let hasVoted = false;
let pendingHostReveal = null; // { id, name } while the host-draw animation is showing

// ---- persistence (survive refresh) ----------------------------------------
function saveSession() {
  localStorage.setItem("traitors_session", JSON.stringify(me));
}
function loadSession() {
  const raw = localStorage.getItem("traitors_session");
  if (raw) {
    try { me = JSON.parse(raw); } catch (e) {}
  }
}
function clearSession() {
  localStorage.removeItem("traitors_session");
}

// ---- who is the host right now? (drawn at random once the game starts) --
function isMeHost() {
  return !!(state && state.host_id && state.host_id === me.playerId);
}

// ---- ambient embers --------------------------------------------------
(function spawnEmbers() {
  const container = $("embers");
  const count = 22;
  for (let i = 0; i < count; i++) {
    const s = document.createElement("span");
    s.style.left = Math.random() * 100 + "vw";
    s.style.setProperty("--drift", (Math.random() * 60 - 30) + "px");
    s.style.animationDuration = (9 + Math.random() * 10) + "s";
    s.style.animationDelay = (Math.random() * 12) + "s";
    container.appendChild(s);
  }
})();

// ---- avatar seal colors (deterministic per player id) --------------------
const SEAL_PALETTES = [
  ["#3a2230", "#20141c"],
  ["#233a2c", "#141f18"],
  ["#2a2e3a", "#191c24"],
  ["#3a2f1e", "#241c11"],
  ["#1e2c3a", "#111a24"],
  ["#33223a", "#1d1424"],
];
function sealColorsFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return SEAL_PALETTES[hash % SEAL_PALETTES.length];
}

// ---- entry screen tabs ------------------------------------------------
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(`tab-${tab.dataset.tab}`).classList.add("active");
  });
});

function showError(msg) {
  const el = $("entryError");
  el.textContent = msg;
  el.classList.remove("hidden");
}

$("btnCreate").addEventListener("click", async () => {
  const name = $("hostName").value.trim();
  if (!name) return showError("Enter your name first.");
  try {
    const res = await fetch("/api/create_room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || "Failed to create room");
    const data = await res.json();
    me = { roomCode: data.room_code, playerId: data.player_id, name, isCreator: true, isTraitor: null };
    saveSession();
    connect();
  } catch (e) {
    showError(e.message);
  }
});

$("btnJoin").addEventListener("click", async () => {
  const code = $("joinCode").value.trim().toUpperCase();
  const name = $("joinName").value.trim();
  if (!code || !name) return showError("Enter a room code and your name.");
  try {
    const res = await fetch("/api/join_room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room_code: code, name }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || "Failed to join room");
    const data = await res.json();
    me = { roomCode: data.room_code, playerId: data.player_id, name, isCreator: false, isTraitor: null };
    saveSession();
    connect();
  } catch (e) {
    showError(e.message);
  }
});

// ---- room code copy ----------------------------------------------------
$("btnCopyCode").addEventListener("click", async () => {
  if (!me.roomCode) return;
  try {
    await navigator.clipboard.writeText(me.roomCode);
    const btn = $("btnCopyCode");
    btn.classList.add("copied");
    btn.textContent = "✓";
    setTimeout(() => { btn.classList.remove("copied"); btn.textContent = "⧉"; }, 1500);
  } catch (e) {}
});

// ---- websocket ---------------------------------------------------------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/${me.roomCode}/${me.playerId}`);

  ws.onopen = () => {
    $("roomBadge").classList.remove("hidden");
    $("roomCodeText").textContent = me.roomCode;
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  };

  ws.onclose = () => {
    ticker("Disconnected. Refresh to try reconnecting.");
  };
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function handleMessage(msg) {
  switch (msg.type) {
    case "state":
      state = msg;
      hasVoted = false; // reset on any fresh state broadcast that isn't mid-vote counting UI
      updateHostBadge();
      if (pendingHostReveal) {
        // Let the reveal animation play out before switching to the next screen.
        setTimeout(() => { pendingHostReveal = null; render(); }, 2400);
      } else {
        render();
      }
      break;
    case "host_announcement":
      pendingHostReveal = { id: msg.host_id, name: msg.host_name };
      $("hostAnnounceName").textContent = msg.host_name;
      showScreen("screen-host-announce");
      break;
    case "choose_traitor_prompt":
      renderSelectList(msg.players);
      break;
    case "you_are_traitor":
      me.isTraitor = msg.is_traitor;
      saveSession();
      break;
    case "host_kill_notice":
      $("hostVictimName").textContent = msg.victim_name;
      showScreen("screen-host-reveal");
      break;
    case "night_reveal":
      ticker(`☠ ${msg.victim_name} was found dead this morning.`);
      break;
    case "vote_result":
      const verdict = msg.was_traitor ? "was the Traitor!" : "was NOT the Traitor.";
      ticker(`🗳 ${msg.eliminated_name} ${verdict}`);
      break;
    case "chat":
      appendChat(msg.from, msg.text);
      break;
    case "error":
      ticker(`⚠ ${msg.message}`);
      break;
  }
}

function updateHostBadge() {
  const badge = $("hostBadge");
  if (state && state.host_name && state.phase !== "LOBBY") {
    $("hostBadgeName").textContent = state.host_name + (isMeHost() ? " (you)" : "");
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

function ticker(text) {
  const el = $("eventTicker");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(ticker._t);
  ticker._t = setTimeout(() => el.classList.add("hidden"), 4000);
}

function appendChat(from, text) {
  const log = $("chatLog");
  const line = document.createElement("div");
  line.className = "chat-line";
  line.innerHTML = `<b>${escapeHtml(from)}:</b> ${escapeHtml(text)}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ---- screen management ---------------------------------------------------
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.add("hidden"));
  $(id).classList.remove("hidden");
}

function render() {
  if (!state) return;

  const myPlayer = state.players.find((p) => p.id === me.playerId);
  const amAlive = myPlayer ? myPlayer.alive : true;
  const amHost = isMeHost();

  switch (state.phase) {
    case "LOBBY":
      showScreen("screen-lobby");
      renderPlayerList("playerList", state.players, false);
      $("playerCount").textContent = `${state.players.length} gathered`;
      if (me.isCreator) {
        $("btnStartGame").classList.remove("hidden");
        $("lobbyHint").classList.add("hidden");
      } else {
        $("btnStartGame").classList.add("hidden");
        $("lobbyHint").classList.remove("hidden");
      }
      break;

    case "SELECT_TRAITOR":
      if (amHost) {
        showScreen("screen-select");
        renderSelectList(state.players.filter((p) => !p.is_host));
      } else {
        showScreen("screen-waiting");
        $("waitingText").textContent = `${state.host_name || "The host"} is choosing the Traitor…`;
      }
      break;

    case "NIGHT":
      if (me.isTraitor) {
        showScreen("screen-night-traitor");
        renderKillList(state.players.filter((p) => p.id !== me.playerId && p.alive && !p.is_host));
      } else if (amHost) {
        showScreen("screen-waiting");
        $("waitingText").textContent = "Waiting for the Traitor to strike…";
      } else {
        showScreen("screen-night-wait");
      }
      break;

    case "REVEAL":
      if (amHost) {
        // screen already shown via host_kill_notice
      } else {
        showScreen("screen-night-wait");
      }
      break;

    case "DISCUSSION":
      showScreen("screen-discussion");
      $("discussionVictim").textContent = state.victim_name
        ? `Last night, ${state.victim_name} was eliminated.`
        : "No one was eliminated last night.";
      renderPlayerList("discussionPlayers", state.players, true);
      if (amHost) {
        $("btnStartVoting").classList.remove("hidden");
        $("discussionHint").classList.add("hidden");
      } else {
        $("btnStartVoting").classList.add("hidden");
        $("discussionHint").classList.remove("hidden");
      }
      break;

    case "VOTING":
      showScreen("screen-voting");
      $("votesInCount").textContent = state.votes_in;
      $("aliveCount").textContent = state.alive_count;
      $("voteProgressBar").style.width = state.alive_count
        ? Math.min(100, (state.votes_in / state.alive_count) * 100) + "%"
        : "0%";
      if (amHost || !amAlive) {
        $("votingList").innerHTML = "";
        $("votedNotice").classList.remove("hidden");
        $("votedNotice").textContent = amHost
          ? "You are moderating — watch the votes come in."
          : "You have been eliminated and can no longer vote.";
      } else if (hasVoted) {
        $("votedNotice").classList.remove("hidden");
        $("votingList").innerHTML = "";
      } else {
        $("votedNotice").classList.add("hidden");
        renderVotingList(state.players.filter((p) => p.alive && !p.is_host && p.id !== me.playerId ? true : (p.alive && !p.is_host)));
      }
      break;

    case "GAME_OVER":
      showScreen("screen-gameover");
      $("gameOverTitle").textContent = state.winner === "traitor" ? "The Traitor Wins" : "The Players Win";
      $("gameOverTitle").className = "section-title " + (state.winner === "traitor" ? "accent-red" : "accent-gold");
      $("gameOverText").textContent =
        state.winner === "traitor"
          ? "The Traitor outlasted the group and struck from within."
          : "The group rooted out the Traitor before it was too late.";
      renderFinalLog(state.log);
      clearSession();
      break;
  }
}

// ---- render helpers --------------------------------------------------

function sealFor(p) {
  const [a, b] = sealColorsFor(p.id);
  return `style="--seal-a:${a};--seal-b:${b}"`;
}

function renderPlayerList(containerId, players, showDeadTag) {
  const el = $(containerId);
  el.innerHTML = "";
  players.forEach((p) => {
    const row = document.createElement("div");
    row.className = "player-row" + (!p.alive ? " dead" : "");
    row.innerHTML = `
      <div class="seal" ${sealFor(p)}>${p.name.charAt(0).toUpperCase()}</div>
      <div class="player-name">${escapeHtml(p.name)}${p.id === me.playerId ? " (you)" : ""}</div>
      ${p.is_host ? '<span class="player-tag host-tag">HOST</span>' : ""}
      ${!p.alive && showDeadTag ? '<span class="player-tag">ELIMINATED</span>' : ""}
      ${!p.connected ? '<span class="player-tag">OFFLINE</span>' : ""}
    `;
    el.appendChild(row);
  });
}

function renderSelectList(players) {
  const el = $("selectList");
  el.innerHTML = "";
  players.forEach((p) => {
    const row = document.createElement("div");
    row.className = "player-row";
    row.innerHTML = `<div class="seal" ${sealFor(p)}>${p.name.charAt(0).toUpperCase()}</div><div class="player-name">${escapeHtml(p.name)}</div>`;
    row.addEventListener("click", () => {
      send({ type: "select_traitor", target_id: p.id });
    });
    el.appendChild(row);
  });
  showScreen("screen-select");
}

function renderKillList(players) {
  const el = $("killList");
  el.innerHTML = "";
  players.forEach((p) => {
    const row = document.createElement("div");
    row.className = "player-row";
    row.innerHTML = `<div class="seal" ${sealFor(p)}>${p.name.charAt(0).toUpperCase()}</div><div class="player-name">${escapeHtml(p.name)}</div>`;
    row.addEventListener("click", () => {
      document.querySelectorAll("#killList .player-row").forEach((r) => r.classList.remove("chosen"));
      row.classList.add("chosen");
      send({ type: "traitor_kill", target_id: p.id });
    });
    el.appendChild(row);
  });
}

function renderVotingList(players) {
  const el = $("votingList");
  el.innerHTML = "";
  players.forEach((p) => {
    const row = document.createElement("div");
    row.className = "player-row";
    row.innerHTML = `<div class="seal" ${sealFor(p)}>${p.name.charAt(0).toUpperCase()}</div><div class="player-name">${escapeHtml(p.name)}${p.id === me.playerId ? " (you)" : ""}</div>`;
    row.addEventListener("click", () => {
      hasVoted = true;
      send({ type: "cast_vote", target_id: p.id });
      render();
    });
    el.appendChild(row);
  });
}

function renderFinalLog(log) {
  const el = $("finalLog");
  el.innerHTML = "";
  (log || []).forEach((line) => {
    const d = document.createElement("div");
    d.textContent = line;
    el.appendChild(d);
  });
}

// ---- action buttons --------------------------------------------------
$("btnStartGame").addEventListener("click", () => send({ type: "start_game" }));
$("btnReveal").addEventListener("click", () => send({ type: "reveal_kill" }));
$("btnStartVoting").addEventListener("click", () => send({ type: "start_voting" }));
$("btnChatSend").addEventListener("click", sendChat);
$("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

function sendChat() {
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text) return;
  send({ type: "chat", text });
  input.value = "";
}

// ---- auto-reconnect on refresh -------------------------------------------
loadSession();
if (me.roomCode && me.playerId) {
  connect();
}