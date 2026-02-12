/*
  Thin web client for the AmongUs backend.
  Backend contract:
  - POST /create_game
  - GET /game_state?game_id=<id>
  - POST /human_action
*/

let gameId = null;
let previousState = null;
let pollTimer = null;
let pollInFlight = false;
let actionSubmitInFlight = false;
let selectedAction = null;
let lastIsHumanTurn = null;
let lastActionSignature = "";
let lastActiveRoom = null;
const seenMeetingMessages = new Set();
const playerState = new Map();
const playerTokenEls = new Map();
const roomPlayerContainers = new Map();

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

const meetingPanel = document.getElementById("meeting-panel");
const meetingFeed = document.getElementById("meeting-feed");
const taskFeed = document.getElementById("task-feed");
const seenTaskEvents = new Set();

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

function isMeetingPhase(phase) {
  return String(phase || "").toLowerCase().includes("meeting");
}

function canonicalRoomName(roomName) {
  const normalized = String(roomName || "").trim().toLowerCase();
  if (!normalized) {
    return "Unknown";
  }
  const match = ROOM_ORDER.find((room) => room.toLowerCase() === normalized);
  return match || "Unknown";
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

function ensurePlayerRecord(playerName) {
  if (!playerState.has(playerName)) {
    playerState.set(playerName, {
      name: playerName,
      room: "Unknown",
      colorName: parseColorName(playerName),
      isHuman: false,
      isDead: false,
    });
  }
  return playerState.get(playerName);
}

function buildPositionMapFromSnapshot(state) {
  const positionMap = new Map();
  const positions = Array.isArray(state.player_positions) ? state.player_positions : [];
  positions.forEach((entry) => {
    if (!entry || !entry.name) {
      return;
    }
    positionMap.set(entry.name, {
      room: canonicalRoomName(entry.room),
      colorName: String(entry.color || parseColorName(entry.name)).toLowerCase(),
      isAlive: entry.is_alive !== false,
    });
  });
  return positionMap;
}

function ensureTokenEl(playerName) {
  if (playerTokenEls.has(playerName)) {
    return playerTokenEls.get(playerName);
  }
  const record = ensurePlayerRecord(playerName);
  const token = document.createElement("div");
  token.className = "player-token";
  token.dataset.player = playerName;
  token.title = record.name;
  const numberMatch = record.name.match(/Player\s+(\d+)/i);
  token.textContent = numberMatch ? `P${numberMatch[1]}` : "P";
  playerTokenEls.set(playerName, token);
  return token;
}

function setHumanTag(token, isHuman) {
  token.classList.toggle("human", isHuman);
  const existing = token.querySelector(".you-tag");
  if (isHuman && !existing) {
    const youTag = document.createElement("span");
    youTag.className = "you-tag";
    youTag.textContent = "YOU";
    token.appendChild(youTag);
  }
  if (!isHuman && existing) {
    existing.remove();
  }
}

function styleToken(token, record) {
  token.style.background = COLOR_MAP[record.colorName] || "#f3f6fb";
  token.style.opacity = record.isDead ? "0.45" : "1";
  token.title = record.name;
  setHumanTag(token, record.isHuman);
}

function moveTokenToRoom(playerName, roomName) {
  const token = ensureTokenEl(playerName);
  const targetRoom = canonicalRoomName(roomName);
  const container = roomPlayerContainers.get(targetRoom);
  if (!container) {
    return;
  }
  if (token.parentElement !== container) {
    container.appendChild(token);
    token.classList.add("moving");
    window.setTimeout(() => token.classList.remove("moving"), 230);
  }
}

function snapshotPositions() {
  const positions = {};
  playerState.forEach((record, name) => {
    positions[name] = record.room;
  });
  return positions;
}

function extractKnownPositionsFromInfo(state) {
  const info = String(state.player_info || "");
  if (!info) {
    return;
  }

  const roomOccupants = new Map();
  const roomLinePattern = /Players in ([^:]+):\s*([^\n]+)/g;
  let roomMatch;
  while ((roomMatch = roomLinePattern.exec(info)) !== null) {
    const room = canonicalRoomName(roomMatch[1]);
    const players = parsePlayersLine(roomMatch[2]);
    const occupantSet = new Set();
    players.forEach((rawName) => {
      const isDead = rawName.includes("(dead)");
      const cleanName = rawName.replace(/\s*\(dead\)\s*/g, "").trim();
      if (!cleanName) {
        return;
      }
      occupantSet.add(cleanName);
      const record = ensurePlayerRecord(cleanName);
      record.room = room;
      record.isDead = isDead;
      record.colorName = parseColorName(cleanName);
    });
    roomOccupants.set(room, occupantSet);
  }

  // Handle observed moves.
  const movePattern = /(Player \d+: [^\n]+?) MOVE from ([A-Za-z ]+) to ([A-Za-z ]+)/g;
  let moveMatch;
  while ((moveMatch = movePattern.exec(info)) !== null) {
    const playerName = moveMatch[1].trim();
    const destinationRoom = canonicalRoomName(moveMatch[3]);
    const record = ensurePlayerRecord(playerName);
    record.room = destinationRoom;
    record.colorName = parseColorName(playerName);
  }

  // Human location snapshot.
  const locationMatch = info.match(/Current Location:\s*([^\n]+)/);
  if (state.human_player_name && locationMatch) {
    const record = ensurePlayerRecord(state.human_player_name);
    record.room = canonicalRoomName(locationMatch[1]);
    record.colorName = parseColorName(state.human_player_name);
  }

  // Immediate leave/enter detection for currently visible room lists.
  roomOccupants.forEach((occupants, room) => {
    playerState.forEach((record) => {
      if (record.room === room && !occupants.has(record.name)) {
        record.room = "Unknown";
      }
    });
  });
}

function updateMap(previous, current) {
  const oldPositions = snapshotPositions();
  const previousPositionMap = previous ? buildPositionMapFromSnapshot(previous) : new Map();
  const currentPositionMap = buildPositionMapFromSnapshot(current);

  playerState.forEach((record) => {
    record.isHuman = false;
  });
  if (current.human_player_name) {
    ensurePlayerRecord(current.human_player_name).isHuman = true;
  }
  if (current.current_player) {
    ensurePlayerRecord(current.current_player);
  }

  if (currentPositionMap.size > 0) {
    currentPositionMap.forEach((position, playerName) => {
      const record = ensurePlayerRecord(playerName);
      record.room = position.room;
      record.colorName = position.colorName;
      record.isDead = !position.isAlive;
    });
  } else {
    // Fallback for older snapshots with no explicit positions.
    extractKnownPositionsFromInfo(current);
  }

  const movedPlayers = new Set();
  if (currentPositionMap.size > 0) {
    currentPositionMap.forEach((position, playerName) => {
      const oldRoom = previousPositionMap.has(playerName)
        ? previousPositionMap.get(playerName).room
        : oldPositions[playerName] || "Unknown";
      if (oldRoom !== position.room) {
        movedPlayers.add(playerName);
      }
    });
  } else {
    Object.keys(oldPositions).forEach((playerName) => {
      const record = playerState.get(playerName);
      if (!record) {
        return;
      }
      if (oldPositions[playerName] !== canonicalRoomName(record.room)) {
        movedPlayers.add(playerName);
      }
    });
  }

  playerState.forEach((record, playerName) => {
    const newRoom = canonicalRoomName(record.room);
    if (movedPlayers.has(playerName) || !playerTokenEls.has(playerName) || !previous) {
      moveTokenToRoom(playerName, newRoom);
    }
    styleToken(ensureTokenEl(playerName), record);
  });

  // Room highlighting for current player.
  if (lastActiveRoom) {
    const prevRoomContainer = roomPlayerContainers.get(lastActiveRoom);
    if (prevRoomContainer) {
      prevRoomContainer.parentElement.classList.remove("active");
    }
  }
  let activeRoom = null;
  if (current.current_player && playerState.has(current.current_player)) {
    activeRoom = canonicalRoomName(playerState.get(current.current_player).room);
    const currentContainer = roomPlayerContainers.get(activeRoom);
    if (currentContainer) {
      currentContainer.parentElement.classList.add("active");
    }
  }
  lastActiveRoom = activeRoom;
}

function renderActionButtons(current) {
  const actions = Array.isArray(current.available_actions) ? current.available_actions : [];
  const actionSignature = buildActionSignature(actions);
  const turnChanged = lastIsHumanTurn !== current.is_human_turn;
  const actionListChanged = lastActionSignature !== actionSignature;
  const shouldRerender = turnChanged || actionListChanged;

  if (!shouldRerender) {
    if (!current.is_human_turn) {
      waitingMessageEl.textContent = "Waiting for your turn...";
    } else if (speechBox.classList.contains("hidden")) {
      waitingMessageEl.textContent = "Your turn. Choose an action.";
    }
    setActionButtonsEnabled(current.is_human_turn && !actionSubmitInFlight);
    return;
  }

  clearActionButtons();
  hideSpeechInput();

  if (!current.is_human_turn) {
    waitingMessageEl.textContent = "Waiting for your turn...";
    lastIsHumanTurn = current.is_human_turn;
    lastActionSignature = actionSignature;
    return;
  }

  waitingMessageEl.textContent = "Your turn. Choose an action.";
  if (actions.length === 0) {
    waitingMessageEl.textContent = "Your turn, but no available actions were provided.";
    lastIsHumanTurn = current.is_human_turn;
    lastActionSignature = actionSignature;
    return;
  }

  actions.forEach((action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.name;
    button.disabled = actionSubmitInFlight || !current.is_human_turn;
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

  lastIsHumanTurn = current.is_human_turn;
  lastActionSignature = actionSignature;
}

function updateSidebar(previous, current) {
  renderActionButtons(current);
}

function updateStatus(previous, current) {
  gameIdEl.textContent = String(gameId ?? "-");
  statusEl.textContent = String(current.status ?? "-");
  phaseEl.textContent = String(current.current_phase ?? "-");
  timestepEl.textContent = String(current.timestep ?? "-");
  currentPlayerEl.textContent = String(current.current_player ?? "-");
  turnStateEl.textContent = current.is_human_turn ? "Human turn" : "Waiting";
}

function extractNewLogLines(previousInfo, currentInfo) {
  const prevLines = new Set(
    String(previousInfo || "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );
  return String(currentInfo || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !prevLines.has(line));
}

function updateLog(previous, current) {
  const currentInfo = current.player_info || "";
  if (!currentInfo) {
    return;
  }
  const prevInfo = previous ? previous.player_info || "" : "";
  const newLines = previous ? extractNewLogLines(prevInfo, currentInfo) : currentInfo.split("\n");
  const filtered = newLines.filter((line) => line.trim().length > 0);
  if (filtered.length === 0) {
    return;
  }
  const stamp = `[T${current.timestep ?? "?"}] [${current.current_phase ?? "unknown"}]`;
  if (latestLogEl.textContent === "No data yet.") {
    latestLogEl.textContent = `${stamp}\n${filtered.join("\n")}`;
  } else {
    latestLogEl.textContent += `\n\n${stamp}\n${filtered.join("\n")}`;
  }
  latestLogEl.scrollTop = latestLogEl.scrollHeight;
}

function parseMeetingMessages(playerInfo) {
  const lines = String(playerInfo || "").split("\n");
  const messages = [];
  const pattern =
    /(?:Timestep\s+(\d+):\s*)?\[(meeting[^\]]*)\]\s*(Player\s+\d+:\s*[^\s]+)\s+SPEAK\s*:?\s*(.*)$/i;
  lines.forEach((line) => {
    const text = line.trim();
    const match = text.match(pattern);
    if (!match) {
      return;
    }
    messages.push({
      timestep: match[1] || "",
      phase: match[2] || "meeting",
      player: match[3].trim(),
      text: match[4].trim() || "...",
    });
  });
  return messages;
}

function appendMeetingMessage(message, isHuman) {
  const groupId = `group-${message.player.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9:-]/g, "")}`;
  let group = meetingFeed.querySelector(`[data-group-id="${groupId}"]`);
  if (!group) {
    group = document.createElement("div");
    group.className = `meeting-group${isHuman ? " human" : ""}`;
    group.dataset.groupId = groupId;

    const speaker = document.createElement("div");
    speaker.className = "speaker";
    speaker.textContent = message.player;
    group.appendChild(speaker);
    meetingFeed.appendChild(group);
  }

  const msgEl = document.createElement("div");
  msgEl.className = "meeting-msg";
  msgEl.textContent = message.timestep
    ? `T${message.timestep}: ${message.text}`
    : message.text;
  group.appendChild(msgEl);
}

function updateMeetingPanel(previous, current) {
  const meeting = isMeetingPhase(current.current_phase);
  meetingPanel.classList.toggle("hidden", !meeting);
  if (!meeting) {
    return;
  }

  let messages = [];
  if (Array.isArray(current.meeting_messages) && current.meeting_messages.length > 0) {
    messages = current.meeting_messages.map((entry) => ({
      timestep: entry.timestep ?? "",
      phase: "meeting",
      player: entry.player,
      text: entry.text,
    }));
  } else {
    messages = parseMeetingMessages(current.player_info || "");
  }
  messages.forEach((message) => {
    const key = `${message.timestep}|${message.player}|${message.text}`;
    if (seenMeetingMessages.has(key)) {
      return;
    }
    seenMeetingMessages.add(key);
    appendMeetingMessage(message, message.player === current.human_player_name);
  });

  if (messages.length > 0) {
    meetingFeed.scrollTo({ top: meetingFeed.scrollHeight, behavior: "smooth" });
  }
}

function parseTaskEventLine(line, current) {
  const observerPattern = /Timestep\s+(\d+):\s*\[task\]\s*(Player\s+\d+:\s*[^\s]+)\s+Seemingly doing task/i;
  const selfPattern = /Timestep\s+(\d+):\s*\[task phase\]\s*Seemingly doing task/i;

  const observerMatch = line.match(observerPattern);
  if (observerMatch) {
    return {
      key: `${observerMatch[1]}|${observerMatch[2]}|seemingly-doing-task`,
      text: `T${observerMatch[1]}: ${observerMatch[2]} seemingly doing task`,
    };
  }

  const selfMatch = line.match(selfPattern);
  if (selfMatch) {
    const playerName = current.current_player || "Unknown player";
    return {
      key: `${selfMatch[1]}|${playerName}|seemingly-doing-task`,
      text: `T${selfMatch[1]}: ${playerName} seemingly doing task`,
    };
  }

  return null;
}

function appendTaskEvent(text) {
  if (taskFeed.textContent.trim() === "No task actions yet.") {
    taskFeed.textContent = "";
  }
  const item = document.createElement("div");
  item.className = "task-event";
  item.textContent = text;
  taskFeed.appendChild(item);
}

function updateTaskFeed(previous, current) {
  const currentInfo = current.player_info || "";
  if (!currentInfo) {
    return;
  }
  const prevInfo = previous ? previous.player_info || "" : "";
  const newLines = previous ? extractNewLogLines(prevInfo, currentInfo) : currentInfo.split("\n");
  newLines.forEach((rawLine) => {
    const line = String(rawLine || "").trim();
    if (!line.includes("Seemingly doing task")) {
      return;
    }
    const event = parseTaskEventLine(line, current);
    if (!event || seenTaskEvents.has(event.key)) {
      return;
    }
    seenTaskEvents.add(event.key);
    appendTaskEvent(event.text);
  });
  if (taskFeed.children.length > 0) {
    taskFeed.scrollTop = taskFeed.scrollHeight;
  }
}

function renderState(current) {
  gameView.classList.remove("hidden");
  logView.classList.remove("hidden");

  updateMap(previousState, current);
  updateStatus(previousState, current);
  updateSidebar(previousState, current);
  updateMeetingPanel(previousState, current);
  updateTaskFeed(previousState, current);
  updateLog(previousState, current);

  if (current.status !== "running") {
    stopPolling();
    hideSpeechInput();
    setActionButtonsEnabled(false);
    waitingMessageEl.textContent = "Game finished.";
    appendStatusLine(
      `Game ${gameId} finished. Winner: ${current.winner ?? "n/a"} | Reason: ${current.winner_reason ?? "n/a"}`
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
    previousState = null;
    seenMeetingMessages.clear();
    meetingFeed.innerHTML = "";
    seenTaskEvents.clear();
    taskFeed.textContent = "No task actions yet.";
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
    const current = await fetchJson(`/game_state?game_id=${encodeURIComponent(gameId)}`);
    renderState(current);
    previousState = current;
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

  // Keep existing behavior unchanged: clear actions immediately after submit.
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
