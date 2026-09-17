"""Gemini copy-quality checker — the Approval Desk's "Language Mode" panel.
Distinct from the pipeline's own OCR module (ocr/module.py): that extracts
whatever text the frames actually show; this grades text a *reviewer
pastes* (the real ad copy/voiceover/overlay script, which may differ from
what OCR caught, or simply not exist on-screen yet at draft stage) for
spelling, grammar, logic, and clarity.

South India D2C ad copy is routinely and deliberately code-mixed (Tanglish/
Kanglish/Manglish/Tenglish, brand names, English CTAs inside a regional-
language sentence) — the prompt is written so that's read as normal register,
not penalized as an error, unless `language_mode` pins a single language.
"""

from __future__ import annotations

import json
import time

from google import genai
from google.genai import types
from pydantic import BaseModel

from app.config import settings


class GeminiCopyQualityError(RuntimeError):
    """Raised when the copy-quality call can't be made or returns unusable output."""


# Same rationale as sales_engine/gemini_sales.py's _MAX_ATTEMPTS — no BullMQ
# -level retry exists for a degraded step, so an in-process retry is what
# actually recovers a transient Gemini 5xx/429.
_MAX_ATTEMPTS = 2
_RETRY_DELAY_SEC = 2.0

_SYSTEM_PROMPT_TEMPLATE = """You are a bilingual (English + South Indian \
regional language) copy editor reviewing ad copy, voiceover script, or \
on-screen text overlay for a South India D2C/growth-brand video ad.

Language mode: {language_mode}. {language_mode_note}

Score the pasted text on 4 axes, each 0-100:
- spelling: literal misspellings only — NOT regional-language transliteration,
  code-mixed phrasing (Tanglish/Kanglish/Manglish/Tenglish), or brand names.
- grammar: subject-verb agreement, tense consistency, punctuation — judged
  against how the text is actually written (code-mixed ad copy has its own
  register; don't penalize it for not reading like formal English prose).
- logic: does the copy make a coherent, non-contradictory claim/offer (no
  conflicting prices, dates, or claims that don't follow from each other)?
- clarity: would a viewer scrolling quickly understand the product, the one
  promise, and the one next action from this text alone?

Return findings as a short list of concrete, specific issues (e.g. "Line 2:
'recieve' should be 'receive'" or "Two different prices stated: ₹499 and
₹599") — empty list if the copy is clean on all 4 axes. Never invent an
issue that isn't actually in the text."""

_LANGUAGE_MODE_NOTES = {
    "auto": "Auto-detect the language mix present and grade accordingly — do "
    "not assume English-only.",
}


class CopyQualityOutput(BaseModel):
    spelling: int
    grammar: int
    logic: int
    clarity: int
    findings: list[str]


_client_cache: genai.Client | None = None


def _client() -> genai.Client:
    global _client_cache
    if _client_cache is None:
        if not settings.gemini_api_key:
            raise GeminiCopyQualityError("GEMINI_API_KEY is not configured")
        _client_cache = genai.Client(api_key=settings.gemini_api_key)
    return _client_cache


def _clamp_score(value: object) -> int:
    try:
        return max(0, min(100, round(float(value))))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0


def check_copy_quality(text: str, language_mode: str = "auto") -> dict:
    if not text.strip():
        return _empty_result()

    note = _LANGUAGE_MODE_NOTES.get(
        language_mode,
        f"The reviewer has pinned this to \"{language_mode}\" — grade "
        "spelling/grammar specifically against that language's conventions "
        "rather than auto-detecting.",
    )
    system_prompt = _SYSTEM_PROMPT_TEMPLATE.format(
        language_mode=language_mode, language_mode_note=note
    )

    last_exc: Exception | None = None
    parsed = None
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            response = _client().models.generate_content(
                model=settings.gemini_model,
                contents=text,
                config=types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    response_mime_type="application/json",
                    response_schema=CopyQualityOutput,
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
        raise GeminiCopyQualityError(
            f"Gemini copy-quality call failed: {last_exc}"
        ) from last_exc

    if isinstance(parsed, list):
        parsed = parsed[0] if parsed else {}

    return {
        "spelling": _clamp_score(parsed.get("spelling")),
        "grammar": _clamp_score(parsed.get("grammar")),
        "logic": _clamp_score(parsed.get("logic")),
        "clarity": _clamp_score(parsed.get("clarity")),
        "findings": parsed.get("findings", []) or [],
    }


def _empty_result() -> dict:
    return {
        "spelling": None,
        "grammar": None,
        "logic": None,
        "clarity": None,
        "findings": [],
    }
