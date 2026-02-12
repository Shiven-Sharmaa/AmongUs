import asyncio
import datetime
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT_DIR))
sys.path.append(str(ROOT_DIR / "among-agents"))

from amongagents.agent.agent import HumanAgent, human_action_futures
from amongagents.envs.configs.game_config import SEVEN_MEMBER_GAME
from amongagents.envs.game import AmongUs
from utils import setup_experiment


@dataclass
class GameRecord:
    game_id: int
    game: AmongUs
    status: str
    task: Optional[asyncio.Task] = None
    error: Optional[str] = None
    winner: Optional[int] = None
    winner_reason: Optional[str] = None


class GameManager:
    def __init__(self) -> None:
        load_dotenv()
        os.environ["FLASK_ENABLED"] = "True"
        self._records: Dict[int, GameRecord] = {}
        self._next_game_id = 1
        self._init_lock = asyncio.Lock()
        self._logs_path = ROOT_DIR / "expt-logs"

    def _get_commit_hash(self) -> str:
        try:
            return (
                subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT_DIR)
                .strip()
                .decode("utf-8")
            )
        except Exception:
            return "unknown"

    def _find_human_agent(self, game: AmongUs) -> Optional[HumanAgent]:
        agents = getattr(game, "agents", None) or []
        for agent in agents:
            if isinstance(agent, HumanAgent):
                return agent
        return None

    def _find_current_agent(self, game: AmongUs) -> Optional[Any]:
        current_player_name = getattr(game, "current_player", None)
        agents = getattr(game, "agents", None) or []
        if not current_player_name:
            return None
        for agent in agents:
            if getattr(agent, "player", None) and agent.player.name == current_player_name:
                return agent
        return None

    async def _run_game(self, game_id: int) -> None:
        record = self._records[game_id]
        try:
            record.status = "running"
            await record.game.run_game()
            record.status = "completed"
            summary = record.game.summary_json.get(f"Game {game_id}", {})
            record.winner = summary.get("winner")
            record.winner_reason = summary.get("winner_reason")
        except Exception as exc:
            record.status = "error"
            record.error = str(exc)
        finally:
            # Best-effort cleanup for stale futures.
            future = human_action_futures.get(game_id)
            if future is not None and not future.done():
                future.cancel()
            human_action_futures.pop(game_id, None)

    async def _wait_for_human_agent_ready(self, game_id: int, timeout_seconds: float = 10.0) -> None:
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        while asyncio.get_running_loop().time() < deadline:
            record = self._records[game_id]
            if record.task and record.task.done():
                exc = record.task.exception()
                if exc:
                    raise RuntimeError(f"Game task failed during initialization: {exc}") from exc
                raise RuntimeError("Game finished before human initialization completed.")

            human_agent = self._find_human_agent(record.game)
            if human_agent is not None:
                return
            await asyncio.sleep(0.05)

        raise TimeoutError("Timed out waiting for HumanAgent initialization.")

    async def create_game(
        self,
        crewmate_model: Optional[str] = None,
        impostor_model: Optional[str] = None,
    ) -> int:
        if not os.getenv("OPENROUTER_API_KEY"):
            raise RuntimeError("OPENROUTER_API_KEY is required.")

        crewmate_model = crewmate_model or "openrouter/free"
        impostor_model = impostor_model or "openrouter/free"

        async with self._init_lock:
            game_id = self._next_game_id
            self._next_game_id += 1

            args = {
                "game_config": SEVEN_MEMBER_GAME,
                "include_human": True,
                "test": False,
                "personality": False,
                "agent_config": {
                    "Impostor": "LLM",
                    "Crewmate": "LLM",
                    "IMPOSTOR_LLM_CHOICES": [impostor_model],
                    "CREWMATE_LLM_CHOICES": [crewmate_model],
                },
                "UI": False,
            }

            date = datetime.datetime.now().strftime("%Y-%m-%d")
            setup_experiment(
                None,
                str(self._logs_path),
                date,
                self._get_commit_hash(),
                args,
            )

            game = AmongUs(
                game_config=args["game_config"],
                include_human=args["include_human"],
                test=args["test"],
                personality=args["personality"],
                agent_config=args["agent_config"],
                UI=None,
                game_index=game_id,
            )
            record = GameRecord(game_id=game_id, game=game, status="initializing")
            self._records[game_id] = record

            record.task = asyncio.create_task(self._run_game(game_id))
            try:
                await self._wait_for_human_agent_ready(game_id)
            except Exception as exc:
                record.status = "error"
                record.error = str(exc)
                if record.task and not record.task.done():
                    record.task.cancel()
                raise
            # Game task may already be running or waiting on human input.
            if record.status not in {"completed", "error"}:
                record.status = "running"

            return game_id

    def _serialize_player_positions(self, game: AmongUs) -> List[Dict[str, Any]]:
        positions: List[Dict[str, Any]] = []
        for player in getattr(game, "players", []) or []:
            positions.append(
                {
                    "name": player.name,
                    "room": player.location,
                    "color": player.color,
                    "is_alive": bool(player.is_alive),
                }
            )
        return positions

    def _serialize_meeting_messages(self, game: AmongUs) -> List[Dict[str, Any]]:
        messages: List[Dict[str, Any]] = []
        for entry in getattr(game, "activity_log", []) or []:
            if entry.get("phase") != "meeting":
                continue
            player_obj = entry.get("player")
            action = entry.get("action")
            if player_obj is None or action is None:
                continue
            action_text = str(action)
            if not action_text.startswith("SPEAK"):
                continue
            message_match = re.match(r"^SPEAK\s*:?\s*(.*)$", action_text, flags=re.IGNORECASE | re.DOTALL)
            message_text = message_match.group(1).strip() if message_match else action_text
            if not message_text:
                message_text = "..."
            round_number = entry.get("round")
            timestep = entry.get("timestep")
            message_id = f"{timestep}:{round_number}:{player_obj.name}:{message_text}"
            messages.append(
                {
                    "id": message_id,
                    "timestep": timestep,
                    "round": round_number,
                    "player": player_obj.name,
                    "text": message_text,
                }
            )
        return messages

    def get_state(self, game_id: int) -> Dict[str, Any]:
        record = self._records.get(game_id)
        if record is None:
            raise KeyError(f"Unknown game_id={game_id}")

        game = record.game
        game_config = getattr(game, "game_config", {}) or {}
        max_timesteps = game_config.get("max_timesteps")
        current_phase = getattr(game, "current_phase", None)
        timestep = getattr(game, "timestep", None)
        current_player = getattr(game, "current_player", None)

        current_agent = self._find_current_agent(game)
        is_human_turn = isinstance(current_agent, HumanAgent)
        human_agent = self._find_human_agent(game)

        available_actions = []
        player_info = None
        current_step = None
        if is_human_turn and human_agent is not None:
            human_state = human_agent.get_current_state_for_web()
            player_info = human_state.get("player_info")
            current_step = human_state.get("current_step")
            raw_actions = human_state.get("available_actions") or []
            for idx, action in enumerate(raw_actions):
                available_actions.append(
                    {
                        "index": idx,
                        "name": action.get("name", ""),
                        "requires_message": bool(action.get("requires_message", False)),
                    }
                )
        elif current_agent is not None and getattr(current_agent, "player", None) is not None:
            # Keep player_info live between human turns for UI reactivity.
            try:
                player_info = current_agent.player.all_info_prompt()
            except Exception:
                player_info = None

        player_positions = self._serialize_player_positions(game)
        meeting_messages = self._serialize_meeting_messages(game)

        return {
            "game_id": game_id,
            "status": record.status,
            "error": record.error,
            "winner": record.winner,
            "winner_reason": record.winner_reason,
            "initialized": bool(getattr(game, "agents", None)),
            "has_human": human_agent is not None,
            "timestep": timestep,
            "max_timesteps": max_timesteps,
            "current_phase": current_phase,
            "current_player": current_player,
            "is_human_turn": is_human_turn,
            "human_player_name": human_agent.player.name if human_agent else None,
            "current_step": current_step,
            "player_info": player_info,
            "available_actions": available_actions,
            "player_positions": player_positions,
            "meeting_messages": meeting_messages,
        }

    def submit_human_action(self, game_id: int, action_index: int, speech_text: Optional[str]) -> None:
        record = self._records.get(game_id)
        if record is None:
            raise KeyError(f"Unknown game_id={game_id}")
        if record.status in {"completed", "error"}:
            raise RuntimeError(f"Game {game_id} is already {record.status}.")

        human_agent = self._find_human_agent(record.game)
        if human_agent is None:
            raise RuntimeError(f"Game {game_id} has no human agent.")

        future = human_action_futures.get(game_id)
        if future is None or future.done():
            raise RuntimeError("Game is not currently waiting for a human action.")

        current_actions = human_agent.current_available_actions or []
        if action_index < 0 or action_index >= len(current_actions):
            raise ValueError(f"action_index out of range: {action_index}")

        payload = {"action_index": action_index, "message": speech_text or ""}
        future.set_result(payload)
