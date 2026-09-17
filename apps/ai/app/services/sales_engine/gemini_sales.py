"""Gemini sales engine — the second Gemini call in the pipeline, judging
copy correctness, projected ROAS lift, and claim-safety risk on a creative
already scored by the Tribe v2 scoring engine (NestJS-side, see
pipeline.processor.ts). Distinct from vision/gemini_vision.py, which only
describes the scene and never sees scores or copy.

Prompt structure adapted from
D:\\Creative-Intelligence\\Creatival_01\\creatival-web's lib/gemini.ts
rubric, narrowed to this step's diagram-specified output (copy corrections /
ROAS / claim safety — not scoring, which lives in the NestJS scoring engine).
"""

from __future__ import annotations

import json
import time

from google import genai
from google.genai import types
from pydantic import BaseModel

from app.config import settings
from app.services.media_fetch import MediaFetchError, fetch_bytes, select_representative


class GeminiSalesError(RuntimeError):
    """Raised when the sales-engine call can't be made or returns unusable output."""


# Same rationale as vision/gemini_vision.py's _MAX_ATTEMPTS — a transient
# Gemini 5xx has no BullMQ-level retry (a degraded step returns normally
# rather than throwing), so a short in-process retry is what actually
# recovers it. Confirmed in practice: an /analyze/sales call that failed
# immediately succeeded seconds later with the identical request.
_MAX_ATTEMPTS = 2
_RETRY_DELAY_SEC = 2.0


# Was 2 — cut to 1 (2026-09-09, explicit user priority: speed over
# thoroughness). This call already has the OCR copy + Tribe scores as
# context; one representative frame is enough to judge copy/claims visually.
_MAX_FRAMES = 1

_SYSTEM_PROMPT = """You are Creatival's sales-conversion reviewer for Meta \
(Facebook/Instagram) ad creatives, judging South India D2C/growth-brand ads \
already scored by an upstream vision/attention model.

If more than one frame is supplied, judge them together as one creative and
respond with a single JSON object — never a list of per-frame entries.

Given the frame(s), the on-screen copy already OCR'd from the creative, and \
its Tribe v2 pillar scores (Creative Quality / Audience & Persona Fit / \
Conversion Safety, each 0-100), produce:
- copy_corrections: up to 5 concrete rewritten lines (typo fixes, sharper \
  CTA, price/urgency framing) — empty array if the copy is already strong.
- roas: a predicted ROAS lift percentage (-12 to 42) and a one-sentence \
  justification tied to the actual scores/copy, not generic praise.
- claim_safety: exaggerated claims, non-compliant promises, or high \
  policy-risk phrasing found in the copy, and an overall risk level."""


# Enforced via response_schema below, not just prompt wording — see
# vision/gemini_vision.py's SceneDescription for why (confirmed in practice:
# multiple image parts can make the model return a JSON array instead of a
# single object).
class RoasEstimate(BaseModel):
    estimate_pct: float
    reasoning: str


class ClaimSafety(BaseModel):
    risk: str
    flags: list[str]


class SalesEngineOutput(BaseModel):
    copy_corrections: list[str]
    roas: RoasEstimate
    claim_safety: ClaimSafety

_client_cache: genai.Client | None = None


def _client() -> genai.Client:
    global _client_cache
    if _client_cache is None:
        if not settings.gemini_api_key:
            raise GeminiSalesError("GEMINI_API_KEY is not configured")
        _client_cache = genai.Client(api_key=settings.gemini_api_key)
    return _client_cache


def analyze_sales(frame_urls: list[str], copy: dict, tribe_scores: dict) -> dict:
    targets = select_representative(frame_urls, _MAX_FRAMES) if frame_urls else []
    parts: list[types.Part | str] = [
        json.dumps({"copy": copy, "tribe_scores": tribe_scores})
    ]
    for url in targets:
        try:
            data = fetch_bytes(url)
        except MediaFetchError:
            continue
        parts.append(types.Part.from_bytes(data=data, mime_type="image/jpeg"))

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
                    response_schema=SalesEngineOutput,
                ),
            )
            parsed = json.loads(response.text)
            last_exc = None
            break
        except Exception as exc:
            last_exc = exc
            if attempt < _MAX_ATTEMPTS:
                time.sleep(_RETRY_DELAY_SEC)
    if last_exc is not None:
        raise GeminiSalesError(f"Gemini sales engine call failed: {last_exc}") from last_exc

    if isinstance(parsed, list):
        parsed = parsed[0] if parsed else {}

    return {
        "copy_corrections": parsed.get("copy_corrections", []),
        "roas": parsed.get("roas", {"estimate_pct": 0, "reasoning": ""}),
        "claim_safety": parsed.get("claim_safety", {"risk": "unknown", "flags": []}),
    }


def _empty_result() -> dict:
    return {
        "copy_corrections": [],
        "roas": {"estimate_pct": 0, "reasoning": ""},
        "claim_safety": {"risk": "unknown", "flags": []},
    }
