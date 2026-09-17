import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.routers import videos, web
from app.services import transcribe


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Preload Whisper off the event loop: the first transcription after a
    # (re)start otherwise pays the multi-second model load inside the request.
    threading.Thread(target=_warm_models, daemon=True).start()
    yield


def _warm_models() -> None:
    try:
        transcribe.warm_up()
    except Exception:
        # Warm-up is best-effort; the request path loads lazily as before.
        pass


app = FastAPI(
    title="Video Intelligence AI Service",
    description="Internal media analysis service for the AI Video Performance "
    "Intelligence Platform. Called only by the NestJS orchestrator.",
    version="0.1.0",
    lifespan=lifespan,
)

app.include_router(videos.router)
app.include_router(web.router)


@app.get("/health", tags=["ops"])
async def health() -> dict[str, str]:
    return {"status": "ok"}
