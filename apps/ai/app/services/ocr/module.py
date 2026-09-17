"""OCR module (parallel analyzer 2 of 4) — reads on-screen text/CTA/script
from the frame-extraction step's already-uploaded frames via pytesseract.

Ported from D:\\Creative-Intelligence\\Creatival_01\\creative-approval-score's
src/app.js `extractContentFromMedia`, minus its OCR-failure fallback that
fabricates per-category marketing copy from a hardcoded template — on
failure this returns empty text instead of invented ad copy.
"""

from __future__ import annotations

import re

import cv2
import pytesseract
from PIL import Image

from app.config import settings
from app.services.media_fetch import MediaFetchError, fetch_image, select_representative

pytesseract.pytesseract.tesseract_cmd = settings.tesseract_bin

# On-screen CTA button verbs — distinct from video_analysis/transcript.py's
# CTA_PATTERNS (which matches *spoken* CTA phrases like "link in bio"); these
# match the short imperative text typical of an on-screen button, mirroring
# app.js's copy-analysis regexes.
_CTA_VERB_PATTERN = re.compile(
    r"\b(order|shop|buy|get|click|visit|book|call|whatsapp|claim)\b", re.IGNORECASE
)
_PRICING_PATTERN = re.compile(r"(₹|rs\.?|inr|\$|\d+\s*%|free|only)", re.IGNORECASE)
_URGENCY_PATTERN = re.compile(
    r"\b(now|today|limited|hurry|exclusive|soon|fast)\b", re.IGNORECASE
)

# Tesseract is real per-frame CPU work — 2-3 representative frames (hook +
# mid + CTA/end) capture on-screen text about as well as OCR-ing every
# sampled frame would for a short-form ad, at a fraction of the cost.
_MAX_FRAMES = 3


def analyze_copy(frame_urls: list[str]) -> dict:
    if not frame_urls:
        return _empty_result()

    targets = select_representative(frame_urls, _MAX_FRAMES)
    script: list[dict] = []
    for index, url in enumerate(targets):
        try:
            image = fetch_image(url)
        except MediaFetchError:
            continue
        text = _ocr_frame(image)
        if text:
            script.append({"frame_index": index, "text": text})

    full_text = " ".join(s["text"] for s in script).strip()
    return {
        "text": full_text,
        "cta": {
            "detected": bool(_CTA_VERB_PATTERN.search(full_text)),
            "phrases": _CTA_VERB_PATTERN.findall(full_text),
            "has_pricing": bool(_PRICING_PATTERN.search(full_text)),
            "has_urgency": bool(_URGENCY_PATTERN.search(full_text)),
        },
        "script": script,
    }


def _ocr_frame(image) -> str:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    pil_image = Image.fromarray(gray)
    try:
        text = pytesseract.image_to_string(pil_image)
    except pytesseract.TesseractNotFoundError:
        # The tesseract binary itself isn't installed/on PATH (see
        # TESSERACT_BIN in .env.example) — not a per-frame OCR failure, but
        # this analyzer should still degrade to empty text rather than
        # crash the whole request, same as a real per-frame OCR failure.
        return ""
    except pytesseract.TesseractError:
        return ""
    return text.strip()


def _empty_result() -> dict:
    return {
        "text": "",
        "cta": {"detected": False, "phrases": [], "has_pricing": False, "has_urgency": False},
        "script": [],
    }
