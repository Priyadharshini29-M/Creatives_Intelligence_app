from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, HttpUrl

from app.services import ffprobe, filetype, frames, transcribe as transcribe_svc, analyze_video
from app.services.video_analysis import transcript as transcript_mod
from app.services.color import analyser as color_analyser
from app.services.ocr import module as ocr_module
from app.services.sales_engine import gemini_sales
from app.services.copy_quality import gemini_copy_quality
from app.services.regional_fit import gemini_regional_fit
from app.services.subject import detector as subject_detector
from app.services.vision import gemini_vision

router = APIRouter(prefix="/v1/videos", tags=["videos"])


class ProbeRequest(BaseModel):
    # Presigned storage URL supplied by the NestJS orchestrator. This service
    # is internal-only and never exposed to end users.
    source_url: HttpUrl
    # Which probing strategy to use — VIDEO (ffprobe, requires a video
    # stream), IMAGE (PIL dimension read), AUDIO (ffprobe audio stream).
    # Defaults to VIDEO for backward compatibility with callers that predate
    # multi-asset-type support.
    media_type: Literal["VIDEO", "IMAGE", "AUDIO"] = "VIDEO"


class ProbeResponse(BaseModel):
    media_type: Literal["VIDEO", "IMAGE", "AUDIO"] = Field(serialization_alias="mediaType")
    # Video-only fields are None for IMAGE/AUDIO; duration is None for IMAGE
    # (a still has no runtime).
    duration_sec: float | None = Field(None, serialization_alias="durationSec")
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    codec: str | None = None

    model_config = {"populate_by_name": True}


@router.post("/probe", response_model=ProbeResponse, response_model_by_alias=True)
async def probe_video(payload: ProbeRequest) -> ProbeResponse:
    source_url = str(payload.source_url)

    if payload.media_type == "IMAGE":
        try:
            info = await filetype.probe_image(source_url)
        except filetype.FileTypeError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return ProbeResponse(
            media_type="IMAGE", width=info.width, height=info.height, codec=info.format
        )

    if payload.media_type == "AUDIO":
        try:
            info = await filetype.probe_audio(source_url)
        except filetype.FileTypeError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return ProbeResponse(media_type="AUDIO", duration_sec=info.duration_sec, codec=info.codec)

    try:
        info = await ffprobe.probe(source_url)
    except ffprobe.ProbeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return ProbeResponse(
        media_type="VIDEO",
        duration_sec=info.duration_sec,
        width=info.width,
        height=info.height,
        fps=info.fps,
        codec=info.codec,
    )


class FrameUploadTarget(BaseModel):
    key: str
    put_url: HttpUrl


class ExtractFramesRequest(BaseModel):
    source_url: HttpUrl
    # One presigned PUT target per frame to sample — the orchestrator sets the
    # sampling budget by how many targets it presigns.
    uploads: list[FrameUploadTarget] = Field(min_length=1, max_length=240)


class FrameResult(BaseModel):
    key: str
    index: int
    timestamp_sec: float = Field(serialization_alias="timestampSec")
    is_scene_start: bool = Field(serialization_alias="isSceneStart")
    brightness: float
    dominant_color: str = Field(serialization_alias="dominantColor")
    motion_score: float = Field(serialization_alias="motionScore")
    face_count: int = Field(serialization_alias="faceCount")
    has_text: bool = Field(serialization_alias="hasText")

    model_config = {"populate_by_name": True}


class ExtractFramesResponse(BaseModel):
    frames: list[FrameResult]

    model_config = {"populate_by_name": True}


# Sync endpoint on purpose: OpenCV work is CPU-bound and blocking, so FastAPI
# runs it in the threadpool instead of stalling the event loop.
@router.post(
    "/frames", response_model=ExtractFramesResponse, response_model_by_alias=True
)
def extract_frames(payload: ExtractFramesRequest) -> ExtractFramesResponse:
    targets = [
        frames.UploadTarget(key=u.key, put_url=str(u.put_url)) for u in payload.uploads
    ]
    try:
        analyses = frames.extract_and_upload(str(payload.source_url), targets)
    except frames.FrameExtractionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return ExtractFramesResponse(
        frames=[
            FrameResult(
                key=a.key,
                index=a.index,
                timestamp_sec=a.timestamp_sec,
                is_scene_start=a.is_scene_start,
                brightness=a.brightness,
                dominant_color=a.dominant_color,
                motion_score=a.motion_score,
                face_count=a.face_count,
                has_text=a.has_text,
            )
            for a in analyses
        ]
    )


class ExtractImageFrameRequest(BaseModel):
    source_url: HttpUrl
    upload: FrameUploadTarget


# IMAGE media's counterpart to /frames: the source *is* the single frame —
# see frames.extract_and_upload_image. Sync for the same reason as /frames.
@router.post("/frames/image", response_model=FrameResult, response_model_by_alias=True)
def extract_image_frame(payload: ExtractImageFrameRequest) -> FrameResult:
    target = frames.UploadTarget(key=payload.upload.key, put_url=str(payload.upload.put_url))
    try:
        a = frames.extract_and_upload_image(str(payload.source_url), target)
    except frames.FrameExtractionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return FrameResult(
        key=a.key,
        index=a.index,
        timestamp_sec=a.timestamp_sec,
        is_scene_start=a.is_scene_start,
        brightness=a.brightness,
        dominant_color=a.dominant_color,
        motion_score=a.motion_score,
        face_count=a.face_count,
        has_text=a.has_text,
    )


class TranscribeRequest(BaseModel):
    source_url: HttpUrl


class TranscriptSegmentOut(BaseModel):
    index: int
    start_sec: float
    end_sec: float
    text: str
    confidence: float | None


class AudioEnergyPointOut(BaseModel):
    timestamp_sec: float
    energy: float


class AudioSpikesOut(BaseModel):
    """Loud-moment detection over the audio track — the audio analog of
    frames.py's per-frame motion score. See audio_spikes.py."""

    timeline: list[AudioEnergyPointOut]
    spike_count: int
    spike_rate_per_10s: float
    avg_energy: float
    spike_score: float


class TranscribeResponse(BaseModel):
    language: str | None
    full_text: str
    segments: list[TranscriptSegmentOut]
    audio_spikes: AudioSpikesOut


# Sync endpoint: Whisper inference is CPU-bound, so FastAPI runs it in the
# threadpool. The lazy model singleton serializes the first load.
@router.post("/transcribe", response_model=TranscribeResponse)
def transcribe_video(payload: TranscribeRequest) -> TranscribeResponse:
    try:
        result = transcribe_svc.transcribe(str(payload.source_url))
    except transcribe_svc.TranscriptionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return TranscribeResponse(
        language=result.language,
        full_text=result.full_text,
        segments=[
            TranscriptSegmentOut(
                index=s.index,
                start_sec=s.start_sec,
                end_sec=s.end_sec,
                text=s.text,
                confidence=s.confidence,
            )
            for s in result.segments
        ],
        audio_spikes=AudioSpikesOut(
            timeline=[
                AudioEnergyPointOut(timestamp_sec=p.timestamp_sec, energy=p.energy)
                for p in result.audio_spikes.timeline
            ],
            spike_count=result.audio_spikes.spike_count,
            spike_rate_per_10s=result.audio_spikes.spike_rate_per_10s,
            avg_energy=result.audio_spikes.avg_energy,
            spike_score=result.audio_spikes.spike_score,
        ),
    )


class AnalyzeSegment(BaseModel):
    text: str
    start_sec: float | None = None
    end_sec: float | None = None


class AnalyzeRequest(BaseModel):
    # Orchestrator may provide presigned frames and/or transcript data.
    source_url: HttpUrl | None = None
    frames: list[FrameResult] = Field(default_factory=list)
    transcript_text: str | None = None
    transcript_segments: list[AnalyzeSegment] = Field(default_factory=list)
    # 0-1, from the transcription step's audio_spikes.spike_score — blended
    # into the TRIBE scoring formulas alongside frame motion (see
    # tribe_v2/client.py). None for callers that never ran transcription.
    audio_spike_score: float | None = None


# Sync endpoint: analyze_video() makes a blocking Modal call (potentially a
# multi-minute cold start + GPU inference) — FastAPI runs sync def routes in
# a thread pool, same as /transcribe above, so it doesn't block the event
# loop and starve other in-flight requests for the duration.
@router.post("/analyze")
def analyze_video_endpoint(payload: AnalyzeRequest):
    # Plain dicts for the analysis facade — field names (snake_case), not the
    # camelCase serialization aliases, because the submodules read snake_case.
    frames_list = [f.model_dump(by_alias=False) for f in payload.frames]
    segments_list = [s.model_dump() for s in payload.transcript_segments]
    result = analyze_video(
        str(payload.source_url) if payload.source_url else "",
        frames_list,
        payload.transcript_text,
        segments_list,
        payload.audio_spike_score,
    )
    return result


class AnalyzeTranscriptRequest(BaseModel):
    transcript_text: str | None = None
    transcript_segments: list[AnalyzeSegment] = Field(default_factory=list)


# Local, rule-based transcript intelligence only (keywords/CTA-phrase
# detection — see video_analysis/transcript.py) — deliberately does NOT call
# tribe_v2.analyze()'s network endpoint. /analyze above bundles both because
# AUDIO media's score genuinely comes from that network call, but VIDEO/IMAGE
# media (see pipeline.processor.ts's runTribeAnalysis) scores from the 4
# parallel analyzers instead and only ever used /analyze for this local part
# — paying for a slow, sometimes-120s-timeout network call whose actual
# output was thrown away every time. This is the fast path for that case.
@router.post("/analyze/transcript")
def analyze_transcript_endpoint(payload: AnalyzeTranscriptRequest):
    segments_list = [s.model_dump() for s in payload.transcript_segments]
    return transcript_mod.analyze_transcript(payload.transcript_text or "", segments_list)


# ─────────────────────────────────────────────
# Parallel analyzers (Creative Intelligence pipeline)
#
# All four take the already-uploaded frame JPEGs' presigned GET URLs (the
# orchestrator generates these from the Frame rows FRAME_EXTRACTION wrote,
# same source for VIDEO's sampled frames and IMAGE's single synthetic
# frame) — none of these re-download/re-decode the source video. All are
# sync endpoints: FastAPI runs sync def routes in the threadpool, matching
# /frames and /transcribe above for the same CPU-bound-work reason.
# ─────────────────────────────────────────────


class AnalyzeFramesRequest(BaseModel):
    frame_urls: list[HttpUrl] = Field(default_factory=list)


@router.post("/analyze/scene")
def analyze_scene_endpoint(payload: AnalyzeFramesRequest):
    try:
        return gemini_vision.analyze_scene([str(u) for u in payload.frame_urls])
    except gemini_vision.GeminiVisionError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/analyze/copy")
def analyze_copy_endpoint(payload: AnalyzeFramesRequest):
    return ocr_module.analyze_copy([str(u) for u in payload.frame_urls])


@router.post("/analyze/colour")
def analyze_colour_endpoint(payload: AnalyzeFramesRequest):
    return color_analyser.analyze_colour([str(u) for u in payload.frame_urls])


@router.post("/analyze/subject")
def analyze_subject_endpoint(payload: AnalyzeFramesRequest):
    return subject_detector.analyze_subject([str(u) for u in payload.frame_urls])


class AnalyzeSalesRequest(BaseModel):
    frame_urls: list[HttpUrl] = Field(default_factory=list)
    # Named copy_json (not `copy`) — BaseModel already defines a `.copy()`
    # method in Pydantic v2, and a field of that name shadows it.
    copy_json: dict = Field(default_factory=dict)
    tribe_scores: dict = Field(default_factory=dict)


@router.post("/analyze/sales")
def analyze_sales_endpoint(payload: AnalyzeSalesRequest):
    try:
        return gemini_sales.analyze_sales(
            [str(u) for u in payload.frame_urls], payload.copy_json, payload.tribe_scores
        )
    except gemini_sales.GeminiSalesError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


# ─────────────────────────────────────────────
# On-demand Approval Desk modules — "Language Mode" copy QC and Regional &
# Language Fit. NOT part of the automatic analyzer fan-out (see the module
# docstrings on copy_quality/gemini_copy_quality.py and
# regional_fit/gemini_regional_fit.py for why) — a reviewer triggers these
# explicitly from apps/api's language-intelligence module.
# ─────────────────────────────────────────────


class AnalyzeCopyQualityRequest(BaseModel):
    text: str
    language_mode: str = "auto"


@router.post("/analyze/copy-quality")
def analyze_copy_quality_endpoint(payload: AnalyzeCopyQualityRequest):
    try:
        return gemini_copy_quality.check_copy_quality(payload.text, payload.language_mode)
    except gemini_copy_quality.GeminiCopyQualityError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


class AnalyzeRegionalFitRequest(BaseModel):
    text: str


@router.post("/analyze/regional-fit")
def analyze_regional_fit_endpoint(payload: AnalyzeRegionalFitRequest):
    try:
        return gemini_regional_fit.analyze_regional_fit(payload.text)
    except gemini_regional_fit.GeminiRegionalFitError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
