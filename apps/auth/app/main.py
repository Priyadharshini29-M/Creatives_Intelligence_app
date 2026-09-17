from fastapi import FastAPI

from app.routers import auth

app = FastAPI(
    title="Video Intelligence Auth Service",
    description="Verifies Supabase-issued session tokens for the NestJS "
    "API. Called only by the NestJS orchestrator — never by the browser.",
    version="0.1.0",
)

app.include_router(auth.router)


@app.get("/health", tags=["ops"])
async def health() -> dict[str, str]:
    return {"status": "ok"}
