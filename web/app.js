/*
  Thin web client for the AmongUs backend.
  Backend contract:
  - POST /create_game
  - GET /game_state?game_id=<id>
  - POST /human_action
*/

let gameId = null;
let pollTimer = null;
let pollInFlight = false;
let actionSubmitInFlight = false;
let selectedAction = null;
let lastIsHumanTurn = null;
let lastActionSignature = "";
let lastLogPayload = "";

const ROOM_ORDER = [
  "Cafeteria",
  "Weapons",
  "Navigation",
  "O2",
  "Shields",
  "Communications",
  "Storage",
  "Admin",
  "Electrical",
  "Lower Engine",
  "Security",
  "Reactor",
  "Upper Engine",
  "Medbay",
  "Unknown",
];

const COLOR_MAP = {
  red: "#ff5f56",
  blue: "#59a6ff",
  green: "#65d96e",
  yellow: "#ffd75c",
  orange: "#ffb05c",
  purple: "#b78bff",
  pink: "#ff84c0",
  brown: "#b9895a",
  black: "#9099a8",
  white: "#f3f6fb",
  cyan: "#6df6ff",
  lime: "#88ff66",
};

const playerState = new Map();
const roomPlayerContainers = new Map();

const createGameBtn = document.getElementById("create-game-btn");
const createStatus = document.getElementById("create-status");
const errorBanner = document.getElementById("error-banner");
const gameView = document.getElementById("game-view");
const logView = document.getElementById("log-view");
const mapGrid = document.getElementById("map-grid");

const gameIdEl = document.getElementById("game-id");
const statusEl = document.getElementById("status");
const phaseEl = document.getElementById("phase");
const timestepEl = document.getElementById("timestep");
const currentPlayerEl = document.getElementById("current-player");
const turnStateEl = document.getElementById("turn-state");
const waitingMessageEl = document.getElementById("waiting-message");
const actionsEl = document.getElementById("actions");
const latestLogEl = document.getElementById("latest-log");

const speechBox = document.getElementById("speech-box");
const speechTextInput = document.getElementById("speech-text");
const submitSpeechBtn = document.getElementById("submit-speech-btn");

function initMapSkeleton() {
  mapGrid.innerHTML = "";
  roomPlayerContainers.clear();

  ROOM_ORDER.forEach((roomName) => {
    const roomEl = document.createElement("div");
    roomEl.className = "room";
    roomEl.dataset.room = roomName;

    const titleEl = document.createElement("div");
    titleEl.className = "room-name";
    titleEl.textContent = roomName;

    const playersEl = document.createElement("div");
    playersEl.className = "room-players";
    playersEl.id = `room-${roomName.replace(/\s+/g, "-").toLowerCase()}`;

    roomEl.appendChild(titleEl);
    roomEl.appendChild(playersEl);
    mapGrid.appendChild(roomEl);
    roomPlayerContainers.set(roomName, playersEl);
  });
}

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.classList.remove("hidden");
}

function clearError() {
  errorBanner.textContent = "";
  errorBanner.classList.add("hidden");
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function appendStatusLine(text) {
  createStatus.textContent = text;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let payload = {};

  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      payload = { detail: raw };
    }
  }

  if (!response.ok) {
    const detail = payload && payload.detail ? payload.detail : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return payload;
}

function hideSpeechInput() {
  selectedAction = null;
  speechTextInput.value = "";
  speechBox.classList.add("hidden");
}

function setActionButtonsEnabled(enabled) {
  const buttons = actionsEl.querySelectorAll("button");
  buttons.forEach((button) => {
    button.disabled = !enabled;
  });
}

function clearActionButtons() {
  actionsEl.innerHTML = "";
}

function buildActionSignature(actions) {
  return actions
    .map((action) => `${action.index}|${action.name}|${action.requires_message ? 1 : 0}`)
    .join("||");
}

function canonicalRoomName(roomName) {
  const normalized = String(roomName || "").trim().toLowerCase();
  if (!normalized) {
    return "Unknown";
  }
  const match = ROOM_ORDER.find((room) => room.toLowerCase() === normalized);
  return match || "Unknown";
}

function ensurePlayerRecord(playerName) {
  if (!playerState.has(playerName)) {
    playerState.set(playerName, {
      name: playerName,
      room: "Unknown",
      colorName: "white",
      isHuman: false,
      isDead: false,
    });
  }
  return playerState.get(playerName);
}

function parseColorName(playerName) {
  const parts = String(playerName).split(":");
  if (parts.length < 2) {
    return "white";
  }
  return parts[1].trim().toLowerCase();
}

function parsePlayersLine(value) {
  if (!value || value.toLowerCase() === "none") {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function updatePlayersFromInfo(playerInfo, humanPlayerName) {
  if (!playerInfo) {
    return;
  }

  // Players in room snapshots.
  const roomLinePattern = /Players in ([^:]+):\s*([^\n]+)/g;
  let roomMatch;
  while ((roomMatch = roomLinePattern.exec(playerInfo)) !== null) {
    const room = canonicalRoomName(roomMatch[1]);
    const players = parsePlayersLine(roomMatch[2]);
    players.forEach((rawName) => {
      const isDead = rawName.includes("(dead)");
      const cleanName = rawName.replace(/\s*\(dead\)\s*/g, "").trim();
      if (!cleanName) {
        return;
      }
      const record = ensurePlayerRecord(cleanName);
      record.room = room;
      record.isDead = isDead;
      record.colorName = parseColorName(cleanName);
    });
  }

  // Move observations.
  const movePattern = /(Player \d+: [^\n]+?) MOVE from ([A-Za-z ]+) to ([A-Za-z ]+)/g;
  let moveMatch;
  while ((moveMatch = movePattern.exec(playerInfo)) !== null) {
    const playerName = moveMatch[1].trim();
    const destinationRoom = canonicalRoomName(moveMatch[3]);
    const record = ensurePlayerRecord(playerName);
    record.room = destinationRoom;
    record.colorName = parseColorName(playerName);
  }

  // Human location snapshot if available.
  const locationMatch = playerInfo.match(/Current Location:\s*([^\n]+)/);
  if (humanPlayerName && locationMatch) {
    const record = ensurePlayerRecord(humanPlayerName);
    record.room = canonicalRoomName(locationMatch[1]);
    record.colorName = parseColorName(humanPlayerName);
  }
}

function renderPlayersToMap(currentPlayerName) {
  roomPlayerContainers.forEach((container, roomName) => {
    container.innerHTML = "";
    const roomEl = container.parentElement;
    roomEl.classList.toggle("active", false);
    if (currentPlayerName) {
      const current = playerState.get(currentPlayerName);
      if (current && current.room === roomName) {
        roomEl.classList.toggle("active", true);
      }
    }
  });

  const grouped = new Map();
  ROOM_ORDER.forEach((room) => grouped.set(room, []));

  playerState.forEach((record) => {
    const room = canonicalRoomName(record.room);
    grouped.get(room).push(record);
  });

  grouped.forEach((players, room) => {
    const container = roomPlayerContainers.get(room);
    if (!container) {
      return;
    }
    players.sort((a, b) => a.name.localeCompare(b.name));
    players.forEach((record) => {
      const token = document.createElement("div");
      token.className = `player-token${record.isHuman ? " human" : ""}`;
      token.title = record.name;
      token.style.background = COLOR_MAP[record.colorName] || "#f3f6fb";
      token.style.opacity = record.isDead ? "0.45" : "1";

      const numberMatch = record.name.match(/Player\s+(\d+)/i);
      token.textContent = numberMatch ? `P${numberMatch[1]}` : "P";

      if (record.isHuman) {
        const youTag = document.createElement("span");
        youTag.className = "you-tag";
        youTag.textContent = "YOU";
        token.appendChild(youTag);
      }
      container.appendChild(token);
    });
  });
}

function updateMap(state) {
  const humanName = state.human_player_name || null;
  playerState.forEach((record) => {
    record.isHuman = false;
  });
  if (humanName) {
    ensurePlayerRecord(humanName).isHuman = true;
  }

  updatePlayersFromInfo(state.player_info || "", humanName);
  if (state.current_player) {
    ensurePlayerRecord(state.current_player);
  }
  renderPlayersToMap(state.current_player || null);
}

function renderActionButtons(state) {
  const actions = Array.isArray(state.available_actions) ? state.available_actions : [];
  const actionSignature = buildActionSignature(actions);
  const turnChanged = lastIsHumanTurn !== state.is_human_turn;
  const actionListChanged = lastActionSignature !== actionSignature;
  const shouldRerender = turnChanged || actionListChanged;

  if (!shouldRerender) {
    if (!state.is_human_turn) {
      waitingMessageEl.textContent = "Waiting for your turn...";
    } else if (speechBox.classList.contains("hidden")) {
      waitingMessageEl.textContent = "Your turn. Choose an action.";
    }
    setActionButtonsEnabled(state.is_human_turn && !actionSubmitInFlight);
    return;
  }

  clearActionButtons();
  hideSpeechInput();

  if (!state.is_human_turn) {
    waitingMessageEl.textContent = "Waiting for your turn...";
    lastIsHumanTurn = state.is_human_turn;
    lastActionSignature = actionSignature;
    return;
  }

  waitingMessageEl.textContent = "Your turn. Choose an action.";
  if (actions.length === 0) {
    waitingMessageEl.textContent = "Your turn, but no available actions were provided.";
    lastIsHumanTurn = state.is_human_turn;
    lastActionSignature = actionSignature;
    return;
  }

  actions.forEach((action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.name;
    button.disabled = actionSubmitInFlight || !state.is_human_turn;
    button.addEventListener("click", async () => {
      if (actionSubmitInFlight) {
        return;
      }
      if (action.requires_message) {
        selectedAction = action;
        speechBox.classList.remove("hidden");
        waitingMessageEl.textContent = "Enter speech text, then submit.";
        speechTextInput.focus();
      } else {
        await submitAction(action.index, "");
      }
    });
    actionsEl.appendChild(button);
  });

  lastIsHumanTurn = state.is_human_turn;
  lastActionSignature = actionSignature;
}

function updateSidebar(state) {
  gameIdEl.textContent = String(gameId ?? "-");
  statusEl.textContent = String(state.status ?? "-");
  phaseEl.textContent = String(state.current_phase ?? "-");
  timestepEl.textContent = String(state.timestep ?? "-");
  currentPlayerEl.textContent = String(state.current_player ?? "-");
  turnStateEl.textContent = state.is_human_turn ? "Human turn" : "Waiting";
  renderActionButtons(state);
}

function updateLog(state) {
  const payload =
    state.player_info && String(state.player_info).trim().length > 0
      ? state.player_info
      : JSON.stringify(
          {
            status: state.status,
            current_phase: state.current_phase,
            timestep: state.timestep,
            current_player: state.current_player,
            is_human_turn: state.is_human_turn,
            winner: state.winner ?? null,
            winner_reason: state.winner_reason ?? null,
          },
          null,
          2
        );

  if (payload === lastLogPayload) {
    return;
  }
  lastLogPayload = payload;

  const stamp = `[T${state.timestep ?? "?"}] [${state.current_phase ?? "unknown"}]`;
  if (latestLogEl.textContent === "No data yet.") {
    latestLogEl.textContent = `${stamp}\n${payload}`;
  } else {
    latestLogEl.textContent += `\n\n${stamp}\n${payload}`;
  }
  latestLogEl.scrollTop = latestLogEl.scrollHeight;
}

function renderState(state) {
  gameView.classList.remove("hidden");
  logView.classList.remove("hidden");
  updateMap(state);
  updateSidebar(state);
  updateLog(state);

  if (state.status !== "running") {
    stopPolling();
    hideSpeechInput();
    setActionButtonsEnabled(false);
    waitingMessageEl.textContent = "Game finished.";
    appendStatusLine(
      `Game ${gameId} finished. Winner: ${state.winner ?? "n/a"} | Reason: ${state.winner_reason ?? "n/a"}`
    );
  }
}

async function createGame() {
  clearError();
  createGameBtn.disabled = true;
  appendStatusLine("Creating game...");

  try {
    const response = await fetchJson("/create_game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    if (typeof response.game_id !== "number") {
      throw new Error("Invalid /create_game response: missing game_id");
    }

    gameId = response.game_id;
    appendStatusLine(`Game created (game_id=${gameId}). Polling state...`);
    await pollGameState();
    pollTimer = setInterval(pollGameState, 1000);
  } catch (error) {
    showError(`Create game failed: ${error.message}`);
    appendStatusLine("Create game failed.");
    stopPolling();
  }
}

async function pollGameState() {
  if (gameId === null || pollInFlight) {
    return;
  }

  pollInFlight = true;
  clearError();
  try {
    const state = await fetchJson(`/game_state?game_id=${encodeURIComponent(gameId)}`);
    renderState(state);
  } catch (error) {
    showError(`Polling failed: ${error.message}`);
    appendStatusLine("Polling stopped due to error.");
    stopPolling();
  } finally {
    pollInFlight = false;
  }
}

async function submitAction(actionIndex, speechText) {
  if (gameId === null) {
    showError("No active game. Create a game first.");
    return;
  }
  if (actionSubmitInFlight) {
    return;
  }

  actionSubmitInFlight = true;
  clearError();
  setActionButtonsEnabled(false);

  // Keep this behavior unchanged: clear actions immediately after submit.
  clearActionButtons();
  hideSpeechInput();
  lastIsHumanTurn = null;
  lastActionSignature = "";
  waitingMessageEl.textContent = "Submitting action...";

  try {
    await fetchJson("/human_action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        game_id: gameId,
        action_index: actionIndex,
        speech_text: speechText,
      }),
    });
    appendStatusLine(`Action ${actionIndex} submitted. Waiting for next state...`);
    waitingMessageEl.textContent = "Waiting for your turn...";
    await pollGameState();
  } catch (error) {
    showError(`Submit action failed: ${error.message}`);
    appendStatusLine("Action submission failed.");
  } finally {
    actionSubmitInFlight = false;
  }
}

createGameBtn.addEventListener("click", createGame);

submitSpeechBtn.addEventListener("click", async () => {
  clearError();
  if (!selectedAction) {
    showError("Select an action that requires a message first.");
    return;
  }

  const speechText = speechTextInput.value.trim();
  if (speechText.length === 0) {
    showError("Speech text is required for this action.");
    return;
  }

  await submitAction(selectedAction.index, speechText);
});

initMapSkeleton();
