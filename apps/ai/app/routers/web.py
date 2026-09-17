from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, HttpUrl

from app.services import webpage

router = APIRouter(prefix="/v1/web", tags=["web"])


class AnalyzePageRequest(BaseModel):
    url: HttpUrl
    # Ad/video keywords the page is expected to mention
    keywords: list[str] = Field(default_factory=list, max_length=50)


# Sync endpoint on purpose: urllib + parsing is blocking, FastAPI runs it in
# the threadpool.
@router.post("/analyze")
def analyze_page(payload: AnalyzePageRequest) -> dict:
    try:
        return webpage.analyze_page(str(payload.url), payload.keywords)
    except webpage.PageFetchError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
