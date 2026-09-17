from typing import Any, Dict, List

from app.services import tribe_v2
from app.services.video_analysis import transcript as transcript_mod

# TRIBE v2's scoring call (see tribe_v2/client.py) requires transcript text —
# a video with no spoken dialogue (b-roll, music-only, visual-only ads) would
# otherwise always fall back to neutral defaults, never getting a real
# score. Substituting a generic caption when there's no speech (same pattern
# the reference prototype uses for its image-upload flow) means silent
# videos still get scored, just less specifically than one with real dialogue.
_SILENT_VIDEO_FALLBACK_CAPTION = (
    "A marketing video with visual advertising elements and no spoken dialogue."
)


def analyze_video(
    source_url: str,
    frames: List[Dict[str, Any]] | None = None,
    transcript_text: str | None = None,
    transcript_segments: List[Dict[str, Any]] | None = None,
    audio_spike_score: float | None = None,
) -> Dict[str, Any]:
    """Facade combining rule-based transcript analysis with TRIBE v2's
    text-scoring pass (hook, sentiment, retention, scroll, conversion).

    TRIBE v2 here is a transcript-text call (see tribe_v2/client.py) — it
    scores the transcript plus the already-computed per-frame motion scores
    and per-clip audio spike score, not the raw video, so ``source_url`` is
    unused for analytics and kept only for callers/signature compatibility.
    """
    results: Dict[str, Any] = {}

    if transcript_text:
        results["transcript"] = transcript_mod.analyze_transcript(
            transcript_text, transcript_segments
        )
    else:
        results["transcript"] = {
            "keywords": [],
            "emotional_keywords": [],
            "cta_detected": False,
            "cta_phrases": [],
            "word_count": 0,
        }

    # The transcript-intelligence block above stays honest about the real
    # (possibly empty) transcript; only the TRIBE scoring input gets the
    # fallback, so CTA/keyword detection never reports the placeholder text.
    scoring_text = transcript_text or _SILENT_VIDEO_FALLBACK_CAPTION
    results.update(tribe_v2.analyze(scoring_text, frames or [], audio_spike_score))
    return results
