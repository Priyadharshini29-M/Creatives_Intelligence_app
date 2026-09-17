from typing import Any, Dict, List
import re
from collections import Counter

# Words that signal a call-to-action in short-form marketing content.
CTA_PATTERNS = (
    "buy", "shop", "order", "purchase", "link in bio", "link below", "click",
    "swipe up", "sign up", "subscribe", "follow", "dm", "comment", "grab",
    "get yours", "check out", "use code", "discount", "sale", "free shipping",
)

# Emotionally-charged words that shift viewer sentiment.
EMOTIONAL_KEYWORDS = (
    "amazing", "incredible", "insane", "crazy", "love", "hate", "best",
    "worst", "secret", "finally", "shocking", "unbelievable", "obsessed",
    "game changer", "life changing", "must have", "perfect", "stunning",
    "guaranteed", "proven", "instantly", "transform",
)

_STOPWORDS = frozenset(
    "the and for you your this that with have from what when where they them "
    "their there here just like will would could should about into over under "
    "been being because before after very really them then than these those "
    "some more most much many can cant dont wont its our out not are was were "
    "get got has had how who whom also only even still going".split()
)


def analyze_transcript(
    text: str, segments: List[Dict[str, Any]] | None = None
) -> Dict[str, Any]:
    """Transcript intelligence: keywords, emotional language, CTA detection.

    When timed segments are provided, CTA phrases are returned with the
    moment they occur so the UI can anchor them on the timeline.
    """
    lower = text.lower()
    # Unicode word runs (optionally apostrophe-joined, e.g. "don't"), not just
    # `[a-z']` — that ASCII-only pattern silently dropped every non-Latin
    # transcript (Tamil, Hindi, etc.) down to whatever stray Latin-looking
    # fragments Whisper hallucinated mid-transcript, which is what "keywords"
    # were actually surfacing on non-English clips: garbage tokens like
    # transliteration artifacts instead of real words from the video.
    raw_words = re.findall(r"[^\W\d_]+(?:'[^\W\d_]+)*", lower)
    words = [w for w in raw_words if len(w) >= 3]

    counts = Counter(w for w in words if w not in _STOPWORDS)
    keywords = [w for w, _ in counts.most_common(10)]

    emotional = [kw for kw in EMOTIONAL_KEYWORDS if kw in lower]

    cta_phrases: List[Dict[str, Any]] = []
    for segment in segments or []:
        seg_text = str(segment.get("text", "")).lower()
        for pattern in CTA_PATTERNS:
            if pattern in seg_text:
                cta_phrases.append(
                    {
                        "text": segment.get("text", "").strip(),
                        "pattern": pattern,
                        "start_sec": segment.get("start_sec"),
                        "end_sec": segment.get("end_sec"),
                    }
                )
                break  # one hit per segment is enough
    # Without segments, still detect CTA presence in the full text.
    cta_detected = bool(cta_phrases) or any(p in lower for p in CTA_PATTERNS)

    return {
        "keywords": keywords,
        "emotional_keywords": emotional,
        "cta_detected": cta_detected,
        "cta_phrases": cta_phrases,
        "word_count": len(words),
    }
