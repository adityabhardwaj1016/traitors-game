// ---------------------------------------------------------------------------
// Traitors — client
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

let ws = null;
let me = { roomCode: null, playerId: null, name: null, isCreator: false, isTraitor: null, locations: [] };
let state = null; // last "state" message from server
let hasVoted = false;
let pendingHostReveal = null; // { id, name } while the host-draw animation is showing
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

// ---- who is the host right now? (drawn at random once the game starts) --
function isMeHost() {
  return !!(state && state.host_id && state.host_id === me.playerId);
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
    me = { roomCode: data.room_code, playerId: data.player_id, name, isCreator: true, isTraitor: null, locations: [] };
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
    me = { roomCode: data.room_code, playerId: data.player_id, name, isCreator: false, isTraitor: null, locations: [] };
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
      updateSpectatorBadge();
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
      if (msg.locations) me.locations = msg.locations;
      saveSession();
      break;
    case "host_kill_notice":
      $("hostVictimName").textContent = msg.victim_name;
      showScreen("screen-host-reveal");
      break;
    case "night_reveal":
      playKillOverlay({ name: msg.victim_name, isMe: msg.victim_id === me.playerId, cause: "night" });
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

function updateHostBadge() {
  const badge = $("hostBadge");
  if (state && state.host_name && state.phase !== "LOBBY") {
    $("hostBadgeName").textContent = state.host_name + (isMeHost() ? " (you)" : "");
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

// ---- spectator status: eliminated players stay in the game, just can't act ----
function amSpectating() {
  if (!state) return false;
  const myPlayer = state.players.find((p) => p.id === me.playerId);
  return !!(myPlayer && !myPlayer.is_host && !myPlayer.alive);
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

// ---- kill / elimination animation --------------------------------------
function playKillOverlay({ name, isMe, cause, wasTraitor }) {
  const overlay = $("killOverlay");
  const textEl = $("killOverlayText");
  const subEl = $("killOverlaySubtext");

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
  setTimeout(() => overlay.classList.add("hidden"), 2300);
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
        renderKillLocationChips();
        updateKillConfirmButton();
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

    case "INVESTIGATION":
      if (amHost) {
        showScreen("screen-investigation-host");
        $("invAlibiCount").textContent = state.alibi_submitted_ids.length;
        $("invAliveCount").textContent = state.alive_count;
        $("invInspectCount").textContent = state.investigations_used;
      } else {
        showScreen("screen-investigation");
        renderInvestigationScreen(amAlive);
      }
      break;

    case "DISCUSSION":
      showScreen("screen-discussion");
      $("discussionVictim").textContent = state.victim_name
        ? `Last night, ${state.victim_name} was eliminated.`
        : "No one was eliminated last night.";
      renderEvidenceBoard();
      renderMyClueNotes();
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
    row.className = "player-row" + (selectedKillTarget === p.id ? " chosen" : "");
    row.innerHTML = `<div class="seal" ${sealFor(p)}>${p.name.charAt(0).toUpperCase()}</div><div class="player-name">${escapeHtml(p.name)}</div>`;
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
      const targets = state.players.filter((p) => p.id !== me.playerId && p.alive && !p.is_host);
      const el = $("inspectList");
      el.innerHTML = "";
      targets.forEach((p) => {
        const row = document.createElement("div");
        row.className = "player-row" + (selectedInspectTarget === p.id ? " chosen" : "");
        row.innerHTML = `<div class="seal" ${sealFor(p)}>${p.name.charAt(0).toUpperCase()}</div><div class="player-name">${escapeHtml(p.name)}</div>`;
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
      const targets = state.players.filter((p) => p.id !== me.playerId && p.alive && !p.is_host);
      const el = $("sabotageList");
      el.innerHTML = "";
      targets.forEach((p) => {
        const row = document.createElement("div");
        row.className = "player-row";
        row.innerHTML = `<div class="seal" ${sealFor(p)}>${p.name.charAt(0).toUpperCase()}</div><div class="player-name">${escapeHtml(p.name)}</div>`;
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
$("btnReveal").addEventListener("click", () => send({ type: "reveal_kill" }));
$("btnStartDiscussionHost").addEventListener("click", () => send({ type: "start_discussion" }));
$("btnStartVoting").addEventListener("click", () => send({ type: "start_voting" }));
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