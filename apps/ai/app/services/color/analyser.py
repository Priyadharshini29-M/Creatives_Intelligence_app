"""Color analyser (parallel analyzer 3 of 4) — the 60/30/10 visual-balance
check from ANALYSIS_RULES.md, ported verbatim (thresholds and formula) from
D:\\Creative-Intelligence\\Creatival_01\\creative-approval-score's src/app.js
`sampleVisualFrame`/`deriveGlobalStandardSignals`.
"""

from __future__ import annotations

import cv2
import numpy as np

from app.services.media_fetch import MediaFetchError, fetch_image, select_representative

# Cheap, pure-numpy work — safe to sample more frames than the LLM-backed
# analyzers without meaningfully affecting cost/latency.
_MAX_FRAMES = 6
_SAMPLE_SIZE = (128, 72)  # (w, h) — matches app.js's 72x128 downsample

# Saturation thresholds from app.js's sampleVisualFrame: pixels above the
# higher threshold (and not near-black/near-white) are the 10% accent/CTA
# tier; above the lower threshold, the 30% support tier; everything else is
# the 60% base tier.
_ACCENT_SAT_THRESHOLD = 0.52
_SUPPORT_SAT_THRESHOLD = 0.14


def analyze_colour(frame_urls: list[str]) -> dict:
    if not frame_urls:
        return _empty_result()

    targets = select_representative(frame_urls, _MAX_FRAMES)
    base_shares: list[float] = []
    support_shares: list[float] = []
    accent_shares: list[float] = []
    base_colors: list[tuple[int, int, int]] = []
    support_colors: list[tuple[int, int, int]] = []
    accent_colors: list[tuple[int, int, int]] = []

    for url in targets:
        try:
            image = fetch_image(url)
        except MediaFetchError:
            continue
        share, colors = _classify_frame(image)
        base_shares.append(share["base"])
        support_shares.append(share["support"])
        accent_shares.append(share["accent"])
        if colors["base"] is not None:
            base_colors.append(colors["base"])
        if colors["support"] is not None:
            support_colors.append(colors["support"])
        if colors["accent"] is not None:
            accent_colors.append(colors["accent"])

    if not base_shares:
        return _empty_result()

    base_share = float(np.mean(base_shares))
    support_share = float(np.mean(support_shares))
    accent_share = float(np.mean(accent_shares))

    # Matches app.js's colourBalance formula exactly.
    balance_score = max(
        0.0,
        min(
            1.0,
            1
            - abs(base_share - 0.6) * 0.55
            - abs(support_share - 0.3) * 0.45
            - abs(accent_share - 0.1) * 0.35,
        ),
    )

    return {
        "palette": {
            "base": _avg_hex(base_colors),
            "support": _avg_hex(support_colors),
            "accent": _avg_hex(accent_colors),
        },
        "balance": {
            "base_share": round(base_share, 4),
            "support_share": round(support_share, 4),
            "accent_share": round(accent_share, 4),
            "score": round(balance_score, 4),
        },
    }


def _classify_frame(image: np.ndarray) -> tuple[dict, dict]:
    small = cv2.resize(image, _SAMPLE_SIZE).astype(np.float32)
    b, g, r = small[..., 0], small[..., 1], small[..., 2]
    maxc = np.max(small, axis=2)
    minc = np.min(small, axis=2)
    saturation = np.where(maxc > 0, (maxc - minc) / np.maximum(maxc, 1e-6), 0)
    luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0

    accent_mask = (saturation > _ACCENT_SAT_THRESHOLD) & (luma > 0.1) & (luma < 0.92)
    support_mask = (~accent_mask) & (saturation > _SUPPORT_SAT_THRESHOLD)
    base_mask = ~(accent_mask | support_mask)

    total = small.shape[0] * small.shape[1]
    share = {
        "base": float(np.count_nonzero(base_mask)) / total,
        "support": float(np.count_nonzero(support_mask)) / total,
        "accent": float(np.count_nonzero(accent_mask)) / total,
    }
    colors = {
        "base": _mean_color(small, base_mask),
        "support": _mean_color(small, support_mask),
        "accent": _mean_color(small, accent_mask),
    }
    return share, colors


def _mean_color(image: np.ndarray, mask: np.ndarray) -> tuple[int, int, int] | None:
    if not np.any(mask):
        return None
    pixels = image[mask]
    b, g, r = (int(round(c)) for c in pixels.mean(axis=0))
    return (r, g, b)


def _avg_hex(colors: list[tuple[int, int, int]]) -> str | None:
    if not colors:
        return None
    arr = np.array(colors)
    r, g, b = (int(round(c)) for c in arr.mean(axis=0))
    return f"#{r:02x}{g:02x}{b:02x}"


def _empty_result() -> dict:
    return {
        "palette": {"base": None, "support": None, "accent": None},
        "balance": {
            "base_share": None,
            "support_share": None,
            "accent_share": None,
            "score": None,
        },
    }
