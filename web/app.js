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

const createGameBtn = document.getElementById("create-game-btn");
const createStatus = document.getElementById("create-status");
const errorBanner = document.getElementById("error-banner");
const gameView = document.getElementById("game-view");
const actionsView = document.getElementById("actions-view");
const logView = document.getElementById("log-view");

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

function renderLatestLog(state) {
  // Prefer player_info as trace-worthy backend text. Fallback to a compact snapshot.
  if (state.player_info && String(state.player_info).trim().length > 0) {
    latestLogEl.textContent = state.player_info;
    return;
  }

  const fallback = {
    status: state.status,
    current_phase: state.current_phase,
    timestep: state.timestep,
    current_player: state.current_player,
    is_human_turn: state.is_human_turn,
    available_actions_count: Array.isArray(state.available_actions) ? state.available_actions.length : 0,
    winner: state.winner ?? null,
    winner_reason: state.winner_reason ?? null,
    error: state.error ?? null,
  };
  latestLogEl.textContent = JSON.stringify(fallback, null, 2);
}

function renderActionButtons(state) {
  const actions = Array.isArray(state.available_actions) ? state.available_actions : [];
  const actionSignature = buildActionSignature(actions);
  const turnChanged = lastIsHumanTurn !== state.is_human_turn;
  const actionListChanged = lastActionSignature !== actionSignature;
  const speechVisible = !speechBox.classList.contains("hidden");
  const shouldRerender = turnChanged || actionListChanged;

  // Preserve human typing state when turn and actions are unchanged.
  if (!shouldRerender) {
    if (!state.is_human_turn) {
      waitingMessageEl.textContent = "Waiting for your turn...";
    } else if (!speechVisible) {
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
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = action.name;
    btn.disabled = actionSubmitInFlight || !state.is_human_turn;
    btn.addEventListener("click", async () => {
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
    actionsEl.appendChild(btn);
  });

  lastIsHumanTurn = state.is_human_turn;
  lastActionSignature = actionSignature;
}

function renderState(state) {
  gameView.classList.remove("hidden");
  actionsView.classList.remove("hidden");
  logView.classList.remove("hidden");

  gameIdEl.textContent = String(gameId ?? "-");
  statusEl.textContent = String(state.status ?? "-");
  phaseEl.textContent = String(state.current_phase ?? "-");
  timestepEl.textContent = String(state.timestep ?? "-");
  currentPlayerEl.textContent = String(state.current_player ?? "-");
  turnStateEl.textContent = state.is_human_turn ? "Human turn" : "Waiting";

  renderLatestLog(state);
  renderActionButtons(state);

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
  createGameBtn.disabled = true; // must remain disabled after click
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

  // Required behavior: clear action buttons immediately after submit.
  clearActionButtons();
  hideSpeechInput();
  // Force a fresh render on the next state snapshot after manual clear.
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
