// ---------------------------------------------------------------------------
// Traitors — client
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

// ---- character roster ----------------------------------------------------
// Cosmetic only. The code tries /static/characters/<id>.jpg first — if that
// 404s, the gradient + icon placeholder shows through automatically. Drop
// real art in at that path (matching these ids) and it's used with zero
// code changes.
const CHARACTERS = [
  { id: "c1",  name: "Arjun",   colorA: "#5a2626", colorB: "#241010", icon: "🗡️" },
  { id: "c2",  name: "Kabir",   colorA: "#28394a", colorB: "#0f1620", icon: "🎭" },
  { id: "c3",  name: "Dev",     colorA: "#3a2f1e", colorB: "#1c150c", icon: "🕯️" },
  { id: "c4",  name: "Vivan",   colorA: "#33223a", colorB: "#180f1e", icon: "👑" },
  { id: "c5",  name: "Neil",    colorA: "#233a2c", colorB: "#0f1a13", icon: "🐺" },
  { id: "c6",  name: "Meera",   colorA: "#3a1e2c", colorB: "#1c0e15", icon: "🌙" },
  { id: "c7",  name: "Tara",    colorA: "#1e2c3a", colorB: "#0e1522", icon: "✨" },
  { id: "c8",  name: "Ishita",  colorA: "#2a3a1e", colorB: "#141c0d", icon: "🦉" },
  { id: "c9",  name: "Ananya",  colorA: "#3a1e1e", colorB: "#1c0d0d", icon: "🕸️" },
  { id: "c10", name: "Rhea",    colorA: "#2c1e3a", colorB: "#150e1c", icon: "🔮" },
  { id: "c11", name: "Diya",    colorA: "#242424", colorB: "#0a0a0a", icon: "🖤" },
  { id: "c12", name: "Gayatri", colorA: "#3a2e1e", colorB: "#1c150c", icon: "👑" },
  { id: "c13", name: "Sana",    colorA: "#3a1414", colorB: "#1c0a0a", icon: "🩸" },
  { id: "c14", name: "Lavanya", colorA: "#14203a", colorB: "#0a101c", icon: "🐦‍⬛" },
];

function charById(id) {
  return CHARACTERS.find((c) => c.id === id) || CHARACTERS[0];
}

let selectedCharacterId = CHARACTERS[0].id;

function renderCharacterGrid() {
  const el = $("characterGrid");
  el.innerHTML = "";
  CHARACTERS.forEach((c) => {
    const frame = document.createElement("div");
    frame.className = "portrait-frame small" + (c.id === selectedCharacterId ? " selected" : "");
    frame.style.setProperty("--seal-a", c.colorA);
    frame.style.setProperty("--seal-b", c.colorB);
    frame.innerHTML = `
      <img class="portrait-photo" src="/static/characters/${c.id}.jpg" alt="" onerror="this.remove()" />
      <div class="portrait-art">${c.icon}</div>
      <div class="portrait-name">${c.name}</div>
    `;
    frame.addEventListener("click", () => {
      selectedCharacterId = c.id;
      document.querySelectorAll("#characterGrid .portrait-frame").forEach((f) => f.classList.remove("selected"));
      frame.classList.add("selected");
    });
    el.appendChild(frame);
  });
}
renderCharacterGrid();

let ws = null;
let me = { roomCode: null, playerId: null, name: null, isCreator: false, isTraitor: null, locations: [], character: null };
let state = null; // last "state" message from server
let hasVoted = false;
let pendingRoleReveal = false; // true while the roles-assigned animation is showing
let lastPhase = null; // used to fire phase-transition side effects (music, stings) only once

// ---- Night kill selection (Traitor) ----
let selectedKillTarget = null;
let selectedKillLocation = null;

// ---- Investigation phase local UI state ----
let selectedAlibi = null;
let selectedInspectTarget = null;
let clueLogEntries = []; // { targetName, clue } — this round's private inspection results
let sabotageNoticeText = "";

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

// ---- is a phase timer active? --------------------------------------------
let timerInterval = null;
function updateTimerBadge() {
  const badge = $("timerBadge");
  if (!state || !state.phase_ends_at) {
    badge.classList.add("hidden");
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    return;
  }
  badge.classList.remove("hidden");
  const tick = () => {
    const msLeft = Math.max(0, state.phase_ends_at - Date.now());
    const secLeft = Math.ceil(msLeft / 1000);
    const m = Math.floor(secLeft / 60);
    const s = secLeft % 60;
    $("timerText").textContent = `${m}:${s.toString().padStart(2, "0")}`;
    badge.classList.toggle("urgent", secLeft <= 10);
  };
  tick();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(tick, 500);
}

function findPlayerById(id) {
  return (state && state.players.find((p) => p.id === id)) || null;
}

// ---- ambient embers ---------------------------------------------------
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

// ---- fallback avatar colors for players missing character data -----------
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
      body: JSON.stringify({ name, character: selectedCharacterId }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || "Failed to create room");
    const data = await res.json();
    me = { roomCode: data.room_code, playerId: data.player_id, name, isCreator: true, isTraitor: null, locations: [], character: selectedCharacterId };
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
      body: JSON.stringify({ room_code: code, name, character: selectedCharacterId }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || "Failed to join room");
    const data = await res.json();
    me = { roomCode: data.room_code, playerId: data.player_id, name, isCreator: false, isTraitor: null, locations: [], character: selectedCharacterId };
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
      updateSpectatorBadge();
      updateTimerBadge();
      if (pendingRoleReveal) {
        // Let the reveal animation play out before switching to the next screen.
        setTimeout(() => { pendingRoleReveal = false; render(); }, 2400);
      } else {
        render();
      }
      break;
    case "roles_assigned":
      pendingRoleReveal = true;
      showScreen("screen-roles-assigned");
      break;
    case "you_are_traitor":
      me.isTraitor = msg.is_traitor;
      if (msg.locations) me.locations = msg.locations;
      saveSession();
      break;
    case "night_reveal":
      playKillOverlay({ id: msg.victim_id, name: msg.victim_name, isMe: msg.victim_id === me.playerId, cause: "night" });
      ticker(`☠ ${msg.victim_name} was found dead in ${msg.crime_location}.`);
      break;
    case "investigation_start":
      // Fresh round of investigation: reset all local UI state for it.
      me.myTrueLocation = msg.your_location;
      me.locations = msg.locations;
      selectedAlibi = null;
      selectedInspectTarget = null;
      clueLogEntries = [];
      sabotageNoticeText = "";
      break;
    case "inspect_result":
      clueLogEntries.push({ targetName: msg.target_name, clue: msg.clue });
      render();
      break;
    case "sabotage_confirmed":
      sabotageNoticeText = `Cover arranged for ${msg.target_name} — inspections of them will come back clean this round.`;
      render();
      break;
    case "vote_result":
      playKillOverlay({
        id: msg.eliminated_id,
        name: msg.eliminated_name,
        isMe: msg.eliminated_id === me.playerId,
        cause: "vote",
        wasTraitor: msg.was_traitor,
      });
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

// ---- spectator status: eliminated players stay in the game, just can't act ----
function amSpectating() {
  if (!state) return false;
  const myPlayer = state.players.find((p) => p.id === me.playerId);
  return !!(myPlayer && !myPlayer.alive);
}

function updateSpectatorBadge() {
  const badge = $("spectatorBadge");
  const spectating = amSpectating();
  badge.classList.toggle("hidden", !spectating);

  const chatInput = $("chatInput");
  const chatBtn = $("btnChatSend");
  chatInput.disabled = spectating;
  chatBtn.disabled = spectating;
  chatInput.placeholder = spectating ? "Spectators can't send messages" : "Say something…";
}

// ---------------------------------------------------------------------------
// Kill / elimination animation — 5 beats:
//   1. Normal   — the victim's framed portrait appears
//   2. Tilts    — the frame tilts as if knocked
//   3. Falls    — it falls off the wall
//   4. Shatters — it breaks into pieces that fly outward
//   5. Spooky   — a red skull glow rises through the smoke
// ---------------------------------------------------------------------------

function playKillOverlay({ id, name, isMe, cause, wasTraitor }) {
  const overlay = $("killOverlay");
  const textEl = $("killOverlayText");
  const subEl = $("killOverlaySubtext");
  const wrap = $("killPortraitWrap");

  const victim = findPlayerById(id);
  const c = victim && victim.character ? charById(victim.character) : null;

  wrap.innerHTML = "";
  if (c) {
    wrap.innerHTML = `
      <div class="portrait-frame large" id="fallingPortrait" style="--seal-a:${c.colorA};--seal-b:${c.colorB}">
        <img class="portrait-photo" src="/static/characters/${c.id}.jpg" alt="" onerror="this.remove()" />
        <div class="portrait-art">${c.icon}</div>
        <div class="portrait-name">${escapeHtml(name)}</div>
      </div>
    `;
  } else {
    wrap.innerHTML = `<div class="dagger">🗡</div>`;
  }

  if (isMe) {
    textEl.textContent = "You have been eliminated";
    subEl.textContent = "You'll stay in the game as a spectator — silent, but watching.";
  } else {
    textEl.textContent = `${name} has fallen`;
    subEl.textContent = cause === "vote"
      ? (wasTraitor ? "They were the Traitor." : "They were not the Traitor.")
      : "Struck down in the night.";
  }

  overlay.classList.remove("hidden");
  document.body.classList.add("shake");
  if (window.TraitorsAudio) TraitorsAudio.playKill();
  setTimeout(() => document.body.classList.remove("shake"), 450);

  if (c) runFrameFallSequence($("fallingPortrait"));

  setTimeout(() => overlay.classList.add("hidden"), 2700);
}

function runFrameFallSequence(el) {
  if (!el) return;
  // Beat 2: tilt
  requestAnimationFrame(() => el.classList.add("tilt"));
  // Beat 3: fall
  setTimeout(() => el.classList.add("fall"), 380);
  // Beat 4 + 5: shatter, then the spooky skull glow
  setTimeout(() => shatterPortrait(el), 900);
}

function shatterPortrait(el) {
  if (!el || !el.isConnected) return;
  const rect = el.getBoundingClientRect();
  const framePalette = { a: el.style.getPropertyValue("--seal-a"), b: el.style.getPropertyValue("--seal-b") };
  el.style.visibility = "hidden";

  const CLIP_POLYS = [
    "polygon(0 0, 60% 0, 40% 55%, 0 40%)",
    "polygon(60% 0, 100% 0, 100% 45%, 40% 55%)",
    "polygon(0 40%, 40% 55%, 30% 100%, 0 100%)",
    "polygon(40% 55%, 100% 45%, 100% 100%, 55% 100%)",
    "polygon(30% 100%, 55% 100%, 65% 70%, 40% 55%)",
    "polygon(100% 45%, 100% 100%, 55% 100%, 65% 70%)",
    "polygon(0 0, 40% 0, 20% 30%, 0 20%)",
  ];

  CLIP_POLYS.forEach((clip) => {
    const shard = document.createElement("div");
    shard.className = "portrait-shard";
    shard.style.left = rect.left + "px";
    shard.style.top = rect.top + "px";
    shard.style.width = rect.width + "px";
    shard.style.height = rect.height + "px";
    shard.style.background = `linear-gradient(135deg, ${framePalette.a}, ${framePalette.b})`;
    shard.style.clipPath = clip;
    const dx = (Math.random() * 220 - 110).toFixed(0) + "px";
    const dy = (90 + Math.random() * 150).toFixed(0) + "px";
    const rot = (Math.random() * 260 - 130).toFixed(0) + "deg";
    shard.style.setProperty("--dx", dx);
    shard.style.setProperty("--dy", dy);
    shard.style.setProperty("--rot", rot);
    shard.style.animation = `shard-fly ${(0.6 + Math.random() * 0.3).toFixed(2)}s ease forwards`;
    document.body.appendChild(shard);
    setTimeout(() => shard.remove(), 1300);
  });

  // Beat 5: spooky vibes — the skull glow rises from where the frame fell
  const skull = document.createElement("div");
  skull.className = "spooky-skull";
  skull.textContent = "💀";
  skull.style.left = (rect.left + rect.width / 2) + "px";
  skull.style.top = (rect.top + rect.height / 2) + "px";
  document.body.appendChild(skull);
  setTimeout(() => skull.remove(), 1700);
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

// ---------------------------------------------------------------------------
// Palace visual system — cross-fades the SVG backdrop behind the game
// panels to match the current phase. See index.html for the scene markup
// and style.css for the crossfade transition.
// ---------------------------------------------------------------------------
const PHASE_TO_SCENE = {
  LOBBY: "hall",
  SELECT_TRAITOR: "chamber",
  NIGHT: "corridor",
  REVEAL: "corridor",
  INVESTIGATION: "study",
  DISCUSSION: "gallery",
  VOTING: "judgment",
  // GAME_OVER is resolved dynamically below (triumph vs ruin)
};

function updatePalaceScene(phase, winner) {
  const target = phase === "GAME_OVER"
    ? (winner === "traitor" ? "ruin" : "triumph")
    : (PHASE_TO_SCENE[phase] || "hall");
  document.querySelectorAll(".palace-backdrop .scene").forEach((el) => {
    el.classList.toggle("active", el.dataset.scene === target);
  });
}

function render() {
  if (!state) return;

  // Fire phase-transition side effects exactly once per transition, not on
  // every state broadcast (which can arrive many times within one phase).
  if (state.phase !== lastPhase) {
    const enteringGameOver = state.phase === "GAME_OVER";
    const enteringLobby = state.phase === "LOBBY" && lastPhase !== null;
    lastPhase = state.phase;
    if (enteringLobby) {
      // A rematch just reset the room — clear anything left over from last game.
      me.isTraitor = null;
      me.locations = [];
      selectedKillTarget = null;
      selectedKillLocation = null;
      selectedAlibi = null;
      selectedInspectTarget = null;
      clueLogEntries = [];
      sabotageNoticeText = "";
      saveSession();
    }
    updatePalaceScene(state.phase, state.winner);
    if (window.TraitorsAudio) {
      TraitorsAudio.setPhase(state.phase);
      if (enteringGameOver) {
        if (state.winner === "traitor") TraitorsAudio.playLose();
        else TraitorsAudio.playWin();
      }
    }
  }

  const myPlayer = state.players.find((p) => p.id === me.playerId);
  const amAlive = myPlayer ? myPlayer.alive : true;

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

    case "NIGHT":
      if (me.isTraitor) {
        showScreen("screen-night-traitor");
        renderKillList(state.players.filter((p) => p.id !== me.playerId && p.alive));
        renderKillLocationChips();
        updateKillConfirmButton();
      } else {
        showScreen("screen-night-wait");
      }
      break;

    case "REVEAL":
      showScreen("screen-night-wait");
      break;

    case "INVESTIGATION":
      showScreen("screen-investigation");
      $("invAlibiCount").textContent = state.alibi_submitted_ids.length;
      $("invAliveCount").textContent = state.alive_count;
      renderInvestigationScreen(amAlive);
      break;

    case "DISCUSSION":
      showScreen("screen-discussion");
      $("discussionVictim").textContent = state.victim_name
        ? `Last night, ${state.victim_name} was eliminated.`
        : "No one was eliminated last night.";
      renderEvidenceBoard();
      renderMyClueNotes();
      renderPlayerList("discussionPlayers", state.players, true);
      renderDiscussionReadyControls(amAlive);
      break;

    case "VOTING":
      showScreen("screen-voting");
      $("votesInCount").textContent = state.votes_in;
      $("aliveCount").textContent = state.alive_count;
      $("voteProgressBar").style.width = state.alive_count
        ? Math.min(100, (state.votes_in / state.alive_count) * 100) + "%"
        : "0%";
      if (!amAlive) {
        $("votingList").innerHTML = "";
        $("votedNotice").classList.remove("hidden");
        $("votedNotice").textContent = "You have been eliminated and can no longer vote.";
      } else if (hasVoted) {
        $("votedNotice").classList.remove("hidden");
        $("votingList").innerHTML = "";
      } else {
        $("votedNotice").classList.add("hidden");
        renderVotingList(state.players.filter((p) => p.alive && p.id !== me.playerId));
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
      renderScoreboard(state.scoreboard);
      if (me.isCreator) {
        $("btnPlayAgain").classList.remove("hidden");
        $("playAgainHint").classList.add("hidden");
      } else {
        $("btnPlayAgain").classList.add("hidden");
        $("playAgainHint").classList.remove("hidden");
      }
      break;
  }
}

// ---- render helpers --------------------------------------------------

function sealFor(p) {
  if (p.character) {
    const c = charById(p.character);
    return `style="--seal-a:${c.colorA};--seal-b:${c.colorB}"`;
  }
  const [a, b] = sealColorsFor(p.id);
  return `style="--seal-a:${a};--seal-b:${b}"`;
}

function sealContent(p) {
  return p.character ? charById(p.character).icon : p.name.charAt(0).toUpperCase();
}

function renderPlayerList(containerId, players, showDeadTag) {
  const el = $(containerId);
  el.innerHTML = "";
  players.forEach((p) => {
    const row = document.createElement("div");
    row.className = "player-row" + (!p.alive ? " dead" : "");
    row.innerHTML = `
      <div class="seal" ${sealFor(p)}>${sealContent(p)}</div>
      <div class="player-name">${escapeHtml(p.name)}${p.id === me.playerId ? " (you)" : ""}</div>
      ${!p.alive && showDeadTag ? '<span class="player-tag">ELIMINATED</span>' : ""}
      ${!p.connected ? '<span class="player-tag">OFFLINE</span>' : ""}
    `;
    el.appendChild(row);
  });
}

function renderKillList(players) {
  const el = $("killList");
  el.innerHTML = "";
  players.forEach((p) => {
    const row = document.createElement("div");
    row.className = "player-row" + (selectedKillTarget === p.id ? " chosen" : "");
    row.innerHTML = `<div class="seal" ${sealFor(p)}>${sealContent(p)}</div><div class="player-name">${escapeHtml(p.name)}</div>`;
    row.addEventListener("click", () => {
      selectedKillTarget = p.id;
      renderKillList(players);
      updateKillConfirmButton();
    });
    el.appendChild(row);
  });
}

function renderKillLocationChips() {
  renderChips("killLocationList", me.locations || [], selectedKillLocation, (loc) => {
    selectedKillLocation = loc;
    renderKillLocationChips();
    updateKillConfirmButton();
  });
}

function updateKillConfirmButton() {
  $("btnConfirmKill").disabled = !(selectedKillTarget && selectedKillLocation);
}

$("btnConfirmKill").addEventListener("click", () => {
  if (!selectedKillTarget || !selectedKillLocation) return;
  send({ type: "traitor_kill", target_id: selectedKillTarget, location: selectedKillLocation });
});

// Generic single-select chip row (used for kill location + alibi claim).
function renderChips(containerId, options, selectedValue, onPick) {
  const el = $(containerId);
  el.innerHTML = "";
  options.forEach((loc) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (loc === selectedValue ? " selected" : "");
    chip.textContent = loc;
    chip.addEventListener("click", () => onPick(loc));
    el.appendChild(chip);
  });
}

function renderInvestigationScreen(amAlive) {
  $("myTrueLocation").textContent = me.myTrueLocation || "—";

  const alibiSubmitted = !!(state && state.my_alibi_submitted);
  const hasInspected = !!(state && state.my_has_inspected);

  // --- alibi claim ---
  if (alibiSubmitted) {
    $("alibiChips").innerHTML = "";
    $("alibiLockedNotice").classList.remove("hidden");
  } else {
    $("alibiLockedNotice").classList.add("hidden");
    renderChips("alibiChips", me.locations || [], selectedAlibi, (loc) => {
      selectedAlibi = loc;
      send({ type: "submit_alibi", location: loc });
    });
  }

  // --- inspect ---
  const inspectSection = $("inspectSection");
  if (me.isTraitor) {
    inspectSection.classList.add("hidden");
  } else {
    inspectSection.classList.remove("hidden");
    if (hasInspected) {
      $("inspectList").innerHTML = '<p class="muted small">Investigation used for this round.</p>';
    } else {
      const targets = state.players.filter((p) => p.id !== me.playerId && p.alive);
      const el = $("inspectList");
      el.innerHTML = "";
      targets.forEach((p) => {
        const row = document.createElement("div");
        row.className = "player-row" + (selectedInspectTarget === p.id ? " chosen" : "");
        row.innerHTML = `<div class="seal" ${sealFor(p)}>${sealContent(p)}</div><div class="player-name">${escapeHtml(p.name)}</div>`;
        row.addEventListener("click", () => {
          selectedInspectTarget = p.id;
          send({ type: "inspect", target_id: p.id });
        });
        el.appendChild(row);
      });
    }
  }

  // --- sabotage (traitor only) ---
  const sabotageSection = $("sabotageSection");
  if (me.isTraitor) {
    sabotageSection.classList.remove("hidden");
    if (!state.sabotage_available) {
      $("sabotageList").innerHTML = "";
      $("sabotageNotice").classList.remove("hidden");
      $("sabotageNotice").textContent = sabotageNoticeText || "Sabotage used for this round.";
    } else {
      $("sabotageNotice").classList.add("hidden");
      const targets = state.players.filter((p) => p.id !== me.playerId && p.alive);
      const el = $("sabotageList");
      el.innerHTML = "";
      targets.forEach((p) => {
        const row = document.createElement("div");
        row.className = "player-row";
        row.innerHTML = `<div class="seal" ${sealFor(p)}>${sealContent(p)}</div><div class="player-name">${escapeHtml(p.name)}</div>`;
        row.addEventListener("click", () => {
          send({ type: "sabotage", target_id: p.id });
        });
        el.appendChild(row);
      });
    }
  } else {
    sabotageSection.classList.add("hidden");
  }

  renderClueLogInto("clueLog");
}

function renderClueLogInto(containerId) {
  const el = $(containerId);
  el.innerHTML = "";
  clueLogEntries.forEach((entry) => {
    const div = document.createElement("div");
    div.className = "clue-entry";
    div.innerHTML = `<span class="clue-target">${escapeHtml(entry.targetName)}</span> — ${escapeHtml(entry.clue)}`;
    el.appendChild(div);
  });
}

function renderEvidenceBoard() {
  const board = $("evidenceBoard");
  if (!state.evidence_board) {
    board.classList.add("hidden");
    return;
  }
  board.classList.remove("hidden");
  $("evidenceCrimeLocation").textContent = `The body was found in ${state.evidence_board.crime_location}.`;
  const el = $("evidenceAlibiList");
  el.innerHTML = "";
  state.evidence_board.alibis.forEach((a) => {
    const row = document.createElement("div");
    row.className = "alibi-row";
    row.innerHTML = `<span class="alibi-name">${escapeHtml(a.name)}${a.id === me.playerId ? " (you)" : ""}</span><span class="alibi-location">${escapeHtml(a.location)}</span>`;
    el.appendChild(row);
  });
}

function renderMyClueNotes() {
  const wrap = $("myClueNotes");
  if (clueLogEntries.length === 0) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  renderClueLogInto("myClueList");
}

function renderDiscussionReadyControls(amAlive) {
  const readyIds = (state && state.discussion_ready_ids) || [];
  const btn = $("btnEndDiscussion");
  const status = $("discussionReadyStatus");
  status.textContent = `${readyIds.length}/${state.alive_count} ready to move on`;

  if (!amAlive) {
    btn.classList.add("hidden");
    return;
  }
  btn.classList.remove("hidden");
  const iAmReady = readyIds.includes(me.playerId);
  btn.disabled = iAmReady;
  btn.textContent = iAmReady ? "Waiting for others…" : "Ready to Move On";
}

function renderVotingList(players) {
  const el = $("votingList");
  el.innerHTML = "";
  players.forEach((p) => {
    const row = document.createElement("div");
    row.className = "player-row";
    row.innerHTML = `<div class="seal" ${sealFor(p)}>${sealContent(p)}</div><div class="player-name">${escapeHtml(p.name)}${p.id === me.playerId ? " (you)" : ""}</div>`;
    row.addEventListener("click", () => {
      hasVoted = true;
      send({ type: "cast_vote", target_id: p.id });
      if (window.TraitorsAudio) TraitorsAudio.playVote();
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

function renderScoreboard(scoreboard) {
  const wrap = $("scoreboardWrap");
  if (!scoreboard || scoreboard.length === 0) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  const el = $("scoreboard");
  el.innerHTML = "";
  scoreboard.forEach((entry, i) => {
    const row = document.createElement("div");
    row.className = "scoreboard-row";
    const traitorBit = entry.times_traitor > 0 ? ` · 🗡 ${entry.traitor_wins}/${entry.times_traitor} as Traitor` : "";
    row.innerHTML = `
      <span class="scoreboard-rank">#${i + 1}</span>
      <span class="scoreboard-name">${escapeHtml(entry.name)}</span>
      <span class="scoreboard-stats">${entry.wins}/${entry.games_played} wins${traitorBit}</span>
    `;
    el.appendChild(row);
  });
}

// ---- action buttons --------------------------------------------------
$("btnStartGame").addEventListener("click", () => send({ type: "start_game" }));
$("btnEndDiscussion").addEventListener("click", () => send({ type: "end_discussion_ready" }));
$("btnPlayAgain").addEventListener("click", () => send({ type: "play_again" }));
$("btnChatSend").addEventListener("click", sendChat);
$("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

function sendChat() {
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text) return;
  send({ type: "chat", text });
  input.value = "";
}

// ---- ambient sound toggle --------------------------------------------
if (window.TraitorsAudio) {
  TraitorsAudio.init();
  const soundBtn = $("btnSound");
  const syncSoundBtn = () => {
    const muted = TraitorsAudio.isMuted();
    soundBtn.textContent = muted ? "🔇" : "🔊";
    soundBtn.classList.toggle("on", !muted);
  };
  syncSoundBtn();
  soundBtn.addEventListener("click", () => {
    TraitorsAudio.toggleMute();
    syncSoundBtn();
  });
}

// ---- auto-reconnect on refresh -------------------------------------------
loadSession();
if (me.roomCode && me.playerId) {
  connect();
}