"""Gemini Vision (parallel analyzer 1 of 4) — scene/object/layout
description per representative frame. Distinct from the Gemini sales engine
(sales_engine/gemini_sales.py), which judges copy/ROAS/claim-safety on an
already-scored creative instead of describing the scene.

Prompt/response-schema pattern adapted from
D:\\Creative-Intelligence\\Creatival_01\\creatival-web's lib/gemini.ts,
narrowed to pure scene description (no scoring — that's the NestJS-side
Tribe v2 scoring engine's job, see pipeline.processor.ts).
"""

from __future__ import annotations

import json
import time

from google import genai
from google.genai import types
from pydantic import BaseModel

from app.config import settings
from app.services.media_fetch import MediaFetchError, fetch_bytes, select_representative


class GeminiVisionError(RuntimeError):
    """Raised when Gemini Vision can't be called or returns unusable output."""


# Gemini occasionally returns a transient 5xx under load (confirmed in
# practice: a call that fails immediately can succeed seconds later with
# identical input — not a real/permanent error). The pipeline itself has no
# BullMQ-level retry for a degraded analyzer step (see
# pipeline.processor.ts's run*Analysis methods — a caught error returns
# normally rather than throwing, so BullMQ never re-attempts it), so a
# short in-process retry here is what actually recovers a transient blip,
# mirroring tribe_v2/client.py's _call_api_with_retry for the same reason.
_MAX_ATTEMPTS = 2
_RETRY_DELAY_SEC = 2.0


# Was 3 — cut to 2 (2026-09-09, explicit user priority: speed over
# thoroughness). Fewer images means a meaningfully faster Gemini response
# (confirmed dominating this step's ~16s latency); still enough to describe
# the creative's opening and closing beats.
_MAX_FRAMES = 2

_SYSTEM_PROMPT = """You are a computer-vision annotator for short-form ad creatives.
You may be given more than one frame from the same creative — describe them
together as a single scene, never as a list of separate per-frame entries.

For the supplied frame(s), describe the scene plainly and factually — do not
judge quality or give marketing advice, another engine handles that.

Field meanings:
- frame_description: one or two plain sentences describing what's on screen.
- scene_and_object_read: what objects/products/people/text are visible and how they're arranged.
- layout: rough visual hierarchy — what draws the eye first, second, third.
- objects: short labels for the concrete objects/subjects detected."""


# Enforced via response_schema below (not just prompt wording) so Gemini
# can't return a JSON array instead of one object — confirmed happening in
# practice with multiple image parts before this was added: the model
# treated "frame(s)" as an instruction to describe each frame separately.
class SceneDescription(BaseModel):
    frame_description: str
    scene_and_object_read: str
    layout: str
    objects: list[str]

_client_cache: genai.Client | None = None


def _client() -> genai.Client:
    global _client_cache
    if _client_cache is None:
        if not settings.gemini_api_key:
            raise GeminiVisionError("GEMINI_API_KEY is not configured")
        _client_cache = genai.Client(api_key=settings.gemini_api_key)
    return _client_cache


def analyze_scene(frame_urls: list[str]) -> dict:
    if not frame_urls:
        return _empty_result()

    targets = select_representative(frame_urls, _MAX_FRAMES)
    parts: list[types.Part] = []
    for url in targets:
        try:
            data = fetch_bytes(url)
        except MediaFetchError:
            continue
        parts.append(types.Part.from_bytes(data=data, mime_type="image/jpeg"))

    if not parts:
        return _empty_result()

    last_exc: Exception | None = None
    parsed = None
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            response = _client().models.generate_content(
                model=settings.gemini_model,
                contents=parts,
                config=types.GenerateContentConfig(
                    system_instruction=_SYSTEM_PROMPT,
                    response_mime_type="application/json",
                    response_schema=SceneDescription,
                ),
            )
            parsed = json.loads(response.text)
            last_exc = None
            break
        except Exception as exc:  # Gemini SDK/network/JSON errors all retry the same way
            last_exc = exc
            if attempt < _MAX_ATTEMPTS:
                time.sleep(_RETRY_DELAY_SEC)
    if last_exc is not None:
        raise GeminiVisionError(f"Gemini Vision call failed: {last_exc}") from last_exc

    # Defensive fallback even with response_schema enforced — take the
    # first entry rather than crash if the model still wraps the object in
    # a list.
    if isinstance(parsed, list):
        parsed = parsed[0] if parsed else {}

    return {
        "frame_description": parsed.get("frame_description", ""),
        "scene_and_object_read": parsed.get("scene_and_object_read", ""),
        "layout": parsed.get("layout", ""),
        "objects": parsed.get("objects", []),
    }


def _empty_result() -> dict:
    return {"frame_description": "", "scene_and_object_read": "", "layout": "", "objects": []}
