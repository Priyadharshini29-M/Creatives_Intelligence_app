"""Client for TRIBE v2's text-scoring endpoint — a third-party-hosted demo
(not our own Modal deployment) that exposes ``facebook/tribev2``'s text/LLaMA
feature-extraction path. It takes a transcript, not a video, so unlike the
Modal-hosted video pipeline this service used previously, it can't produce a
per-timestamp retention timeline or true audience-tribe segments — those
fields below are populated as best-effort approximations (hook/scroll/
conversion derived from the same fixed-weight formulas the reference
prototype used) rather than measured from a trained model.

The endpoint has no SLA — it's someone else's public Hugging Face Space, not
infrastructure this project controls. It has previously been observed down
entirely (its host has no GPU, so any real call errors out).
"""

from __future__ import annotations

import re
import time
from typing import Any

import httpx

TRIBE_TEXT_API_URL = "https://janrudolph-tribe-v2-api.hf.space/predict"
# This is a CPU-only public demo Space (see module docstring) — real, healthy
# responses have been observed anywhere from ~100ms to ~50s depending on its
# current load, with longer transcripts likely pushing past that. 300s meant
# a genuine hang left the whole pipeline step (and the user watching "still
# running") stuck for 5 minutes; 60s cut it too close against observed
# real (non-hung) latency. 120s gives real slow-but-working calls headroom
# without reintroducing a multi-minute stall on an actual hang.
_REQUEST_TIMEOUT_SEC = 120


class TribeV2Error(RuntimeError):
    """Raised when the TRIBE v2 text-scoring call fails."""


# Mirrors tribe_head.postprocess.EMOTIONS field names (kept as a plain
# constant here, not an import, so this service never needs torch).
_EMOTIONS = (
    "happiness",
    "excitement",
    "trust",
    "fear",
    "confusion",
    "urgency",
    "curiosity",
)


def empty_result() -> dict:
    """Neutral defaults when there's no transcript to score at all (e.g. a
    silent video — the text endpoint requires at least 5 characters)."""
    return {
        "calibrated": False,
        "hook": {"score": 0.5, "issues": [], "recommendations": []},
        "sentiment": {
            "emotions": {name: round(1 / len(_EMOTIONS), 3) for name in _EMOTIONS}
        },
        "retention": {
            "timeline": [],
            "hook_rate": None,
            "hold_rate": None,
            "avg_play_time_sec": None,
            "duration_sec": None,
        },
        "scroll": {
            "thumb_pause_prob": None,
            "scroll_stop_prob": None,
            "first_impression_score": None,
            "signals": [],
        },
        "conversion": {"conversion_score": None, "reasons": []},
        "tribe": {"segments": {}, "signals": []},
    }


def _average_motion(frames: list[dict[str, Any]]) -> float:
    """Matches the reference prototype's ``calculate_motion_score`` exactly:
    it averages raw 0-255 grayscale frame-diffs, then does ``min(100, avg *
    2)``. frames.py's ``motion_score`` is that same mean-abs-diff already
    normalized to 0-1 (i.e. divided by 255) — so reversing that back to a
    0-255 value before applying the reference's ``* 2`` cap is
    ``motion_score * 255 * 2`` = ``motion_score * 510``. Using ``* 100``
    instead (as an earlier version of this function did) would understate
    motion's contribution to hook/click/scroll-stop by ~5x. Defaults to a
    neutral midpoint when no frames were sampled (e.g. probe-only calls),
    matching the reference's ``len(frames) < 2`` fallback."""
    scores = [
        float(f["motion_score"]) * 510
        for f in frames
        if f.get("motion_score") is not None
    ]
    if not scores:
        return 50.0
    return min(100.0, sum(scores) / len(scores))


def _combined_motion(frames: list[dict[str, Any]], audio_spike_score: float | None) -> float:
    """Blends visual motion (frame-diff, see _average_motion) with audio
    energy spikes (loud moments — sound effects, music hits, emphasis; see
    audio_spikes.py) into one 0-100 "activity" input for the formulas below.
    Both inputs represent the same underlying idea — something changing
    fast enough to hold attention — just measured in different modalities,
    so they're weighted equally rather than one dominating. Falls back to
    visual motion alone when there's no audio signal (e.g. a muted video, or
    a caller that never ran transcription)."""
    visual = _average_motion(frames)
    if audio_spike_score is None:
        return visual
    audio = max(0.0, min(100.0, audio_spike_score * 100))
    return (visual + audio) / 2


# This endpoint runs on CPU only (see module docstring), so its inference
# time scales with input length — a 2-word request took 27s, a ~40-word one
# hung well past 3 minutes in direct testing. Longer transcripts almost
# never add proportionally useful scoring signal (attention/emotion/imagery
# saturate on a representative excerpt), so capping the input trades a
# little precision on very long transcripts for a much more reliable call.
_MAX_WORDS_FOR_INFERENCE = 60


def _capped_for_inference(text: str) -> str:
    words = text.split()
    if len(words) <= _MAX_WORDS_FOR_INFERENCE:
        return text
    return " ".join(words[:_MAX_WORDS_FOR_INFERENCE])


# Whisper hallucinates degenerate, highly-repetitive filler on silence/music
# when VAD isn't active (see transcribe.py's no-VAD fallback). Confirmed
# directly: 10 *clean* words scored in 32.7s; two different transcripts with
# this kind of repetition each hung past 130s with no response — the demo's
# CPU-bound tokenizer/model appears to choke specifically on repetition, not
# just input length. Seen in two shapes so far, both checked for: a short
# character run repeated many times ("ururururur...") and a whole phrase
# looping ("did it you know did it you know did it you know..."). This text
# carries no real signal anyway, so it's routed through the same
# empty-transcript fallback rather than sent to the API.
_DEGENERATE_CHAR_REPEAT_PATTERN = re.compile(r"(.{1,4})\1{5,}")


def _has_repeated_phrase(words: list[str]) -> bool:
    """True if a run of words repeats suspiciously often. Single-word repeats
    need a much higher bar than multi-word ones — real speech legitimately
    repeats one word for emphasis ("no no no", "come on come on"), but
    essentially never loops an exact 2+ word phrase verbatim 3 times the way
    Whisper's hallucinated filler does."""
    for n, min_repeats in ((1, 6), (2, 3), (3, 3), (4, 3)):
        window = n * min_repeats
        for i in range(len(words) - window + 1):
            phrase = words[i : i + n]
            if all(
                words[i + k * n : i + (k + 1) * n] == phrase
                for k in range(1, min_repeats)
            ):
                return True
    return False


def _looks_degenerate(text: str) -> bool:
    if _DEGENERATE_CHAR_REPEAT_PATTERN.search(text):
        return True
    words = text.split()
    return len(words) >= 9 and _has_repeated_phrase(words)


# This demo has flipped between working and a bare 500 (its host losing GPU
# access — see module docstring) within minutes of each other in practice,
# so a second attempt after a short pause has a real chance of landing on a
# healthy moment instead of the same failure. 500s/connection errors return
# fast, so this doesn't meaningfully add to the worst-case latency the way
# retrying a genuine hang would.
_MAX_ATTEMPTS = 2
_RETRY_DELAY_SEC = 3


def _call_api_with_retry(text: str) -> dict:
    last_error: TribeV2Error | None = None
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            return _call_api_once(text)
        except TribeV2Error as exc:
            last_error = exc
            if attempt < _MAX_ATTEMPTS:
                time.sleep(_RETRY_DELAY_SEC)
    raise last_error  # type: ignore[misc]


def _call_api_once(text: str) -> dict:
    try:
        response = httpx.post(
            TRIBE_TEXT_API_URL,
            json={"text": text},
            timeout=_REQUEST_TIMEOUT_SEC,
        )
        response.raise_for_status()
        data = response.json()
    except httpx.HTTPError as exc:
        raise TribeV2Error(f"TRIBE v2 text API request failed: {exc}") from exc

    if data.get("error"):
        raise TribeV2Error(f"TRIBE v2 text API returned an error: {data['error']}")
    return data


def analyze(
    transcript_text: str | None,
    frames: list[dict[str, Any]],
    audio_spike_score: float | None = None,
) -> dict:
    """Scores a video from its transcript text + already-computed per-frame
    motion scores + per-clip audio spike score. Returns the analytics dict
    described in packages/tribe-head/tribe_head/postprocess.py, with
    ``calibrated: False`` since these are fixed hand-picked weights, not a
    trained model.
    """
    if not transcript_text or len(transcript_text.strip()) < 5:
        return empty_result()
    if _looks_degenerate(transcript_text):
        return empty_result()

    data = _call_api_with_retry(_capped_for_inference(transcript_text))

    scores = data.get("scores", {})
    attention = float(scores.get("attention_capture", 50))
    emotional = float(scores.get("emotional_valence", 50))
    engagement = float(scores.get("overall_brain_engagement", 50))
    imagery = float(scores.get("visual_imagery", 50))
    motion = _combined_motion(frames, audio_spike_score)

    hook_strength = attention * 0.4 + motion * 0.3 + imagery * 0.3
    click_probability = (
        attention * 0.35 + emotional * 0.20 + engagement * 0.25 + motion * 0.20
    )
    scroll_stop = motion * 0.40 + attention * 0.40 + imagery * 0.20

    def pct(value: float) -> float:
        return round(max(0.0, min(100.0, value)) / 100, 4)

    return {
        "calibrated": False,
        "hook": {"score": pct(hook_strength), "issues": [], "recommendations": []},
        "sentiment": {
            "emotions": {
                "attention_capture": pct(attention),
                "emotional_valence": pct(emotional),
                "overall_brain_engagement": pct(engagement),
                "visual_imagery": pct(imagery),
            }
        },
        "retention": {
            # No per-timestamp signal from a text-only call.
            "timeline": [],
            "hook_rate": pct(hook_strength),
            "hold_rate": None,
            "avg_play_time_sec": None,
            "duration_sec": None,
        },
        "scroll": {
            "thumb_pause_prob": None,
            "scroll_stop_prob": pct(scroll_stop),
            "first_impression_score": pct(hook_strength),
            "signals": [],
        },
        "conversion": {"conversion_score": pct(click_probability), "reasons": []},
        "tribe": {"segments": {}, "signals": []},
    }
