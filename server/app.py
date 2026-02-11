from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

try:
    from .game_manager import GameManager
except ImportError:
    from game_manager import GameManager

ROOT_DIR = Path(__file__).resolve().parents[1]
WEB_DIR = ROOT_DIR / "web"

app = FastAPI(title="AmongUs Thin Web Wrapper")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/web", StaticFiles(directory=str(WEB_DIR)), name="web")

manager = GameManager()


class CreateGameRequest(BaseModel):
    crewmate_model: Optional[str] = "openrouter/free"
    impostor_model: Optional[str] = "openrouter/free"


class CreateGameResponse(BaseModel):
    game_id: int
    status: str


class HumanActionRequest(BaseModel):
    game_id: int
    action_index: int = Field(ge=0)
    speech_text: Optional[str] = ""


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(str(WEB_DIR / "index.html"))


@app.post("/create_game", response_model=CreateGameResponse)
async def create_game(request: CreateGameRequest) -> CreateGameResponse:
    try:
        game_id = await manager.create_game(
            crewmate_model=request.crewmate_model,
            impostor_model=request.impostor_model,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return CreateGameResponse(game_id=game_id, status="running")


@app.get("/game_state")
async def game_state(game_id: int):
    try:
        return manager.get_state(game_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/human_action")
async def human_action(request: HumanActionRequest):
    try:
        manager.submit_human_action(
            game_id=request.game_id,
            action_index=request.action_index,
            speech_text=request.speech_text,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "accepted"}
