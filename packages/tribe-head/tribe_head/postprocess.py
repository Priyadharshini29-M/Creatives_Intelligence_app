"""Turns raw TRIBE v2 vertex predictions into the product's analytics contract.

This is the one place that decides what "hook score", "retention timeline",
"conversion score" etc. mean in terms of TRIBE v2 output — every consumer
(Modal service, local dev, training script) should call through here so the
mapping never drifts between environments.
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass

import numpy as np
import torch

from .model import (
    EMOTIONS,
    HEMODYNAMIC_OFFSET_SEC,
    HOOK_WINDOW_SEC,
    TRIBES,
    TribeHead,
)

_head_lock = threading.Lock()
_head_cache: dict[str, TribeHead] = {}


@dataclass(frozen=True)
class Segment:
    start_sec: float
    duration_sec: float


def normalize_segments(raw_segments: list) -> list[Segment]:
    """TRIBE v2's ``predict()`` returns segment objects whose exact type can
    vary (dict rows, dataclass-like objects) — accept either."""
    out: list[Segment] = []
    for seg in raw_segments:
        if isinstance(seg, dict):
            start = float(seg.get("start", 0.0))
            duration = float(seg.get("duration", 0.0))
        else:
            start = float(getattr(seg, "start", 0.0))
            duration = float(getattr(seg, "duration", 0.0))
        out.append(Segment(start_sec=start, duration_sec=duration))
    return out


def load_head(n_vertices: int, weights_path: str | None) -> tuple[TribeHead, bool]:
    """Loads (and caches) the head for this vertex dimensionality.

    Returns (head, calibrated) — calibrated is False whenever no weights
    file was found, i.e. the head is still randomly initialized and its
    outputs must not be treated as real predictions.
    """
    cache_key = f"{n_vertices}:{weights_path}"
    with _head_lock:
        cached = _head_cache.get(cache_key)
        if cached is not None:
            return cached, bool(weights_path and os.path.exists(weights_path))

        head = TribeHead(n_vertices)
        calibrated = bool(weights_path and os.path.exists(weights_path))
        if calibrated:
            state = torch.load(weights_path, map_location="cpu")
            head.load_state_dict(state)
        head.eval()
        _head_cache[cache_key] = head
        return head, calibrated


def empty_result() -> dict:
    """Neutral defaults when there is no video to analyze at all."""
    return {
        "calibrated": False,
        "hook": {"score": 0.5, "issues": [], "recommendations": []},
        "sentiment": {
            "emotions": {name: round(1 / len(EMOTIONS), 3) for name in EMOTIONS}
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


def analyze(
    vertices: np.ndarray,
    raw_segments: list,
    weights_path: str | None,
) -> dict:
    """``vertices``: (n_segments, n_vertices) TRIBE v2 predictions for one
    video. ``raw_segments``: TRIBE v2's per-segment metadata, same length."""
    if vertices.size == 0 or not raw_segments:
        return empty_result()

    segments = normalize_segments(raw_segments)
    head, calibrated = load_head(vertices.shape[1], weights_path)

    with torch.no_grad():
        out = head(torch.from_numpy(np.asarray(vertices, dtype=np.float32)))

    emotions = {
        name: round(float(v), 4) for name, v in zip(EMOTIONS, out["emotions"].tolist())
    }
    tribe_scores = {
        name: round(float(v), 4) for name, v in zip(TRIBES, out["tribe"].tolist())
    }

    ordered = sorted(range(len(segments)), key=lambda i: segments[i].start_sec)
    hazards = out["hazard"].tolist()

    timeline: list[dict] = []
    survival = 1.0
    expected_watch = 0.0
    prev_ts = 0.0
    hook_rate: float | None = None

    for i in ordered:
        ts = max(0.0, segments[i].start_sec - HEMODYNAMIC_OFFSET_SEC)
        hazard = min(0.99, max(0.0, float(hazards[i])))

        expected_watch += survival * max(0.0, ts - prev_ts)
        survival *= 1.0 - hazard

        timeline.append(
            {
                "timestamp": round(ts, 3),
                "drop_prob": round(hazard, 3),
                "survival": round(survival, 4),
            }
        )
        if hook_rate is None and ts >= HOOK_WINDOW_SEC:
            hook_rate = survival
        prev_ts = ts

    if hook_rate is None:
        hook_rate = survival

    last = segments[ordered[-1]]
    duration = max(0.0, last.start_sec + last.duration_sec - HEMODYNAMIC_OFFSET_SEC)

    hook_score = round(1.0 - min(0.99, max(0.0, float(hazards[ordered[0]]))), 3)
    thumb = round(float(out["thumb_pause"].item()), 3)
    scroll_stop = round(thumb * hook_rate, 3)
    first_impression = round((thumb + hook_score) / 2, 3)
    conversion = round(float(out["conversion"].item()), 3)

    return {
        "calibrated": calibrated,
        "hook": {"score": hook_score, "issues": [], "recommendations": []},
        "sentiment": {"emotions": emotions},
        "retention": {
            "timeline": timeline,
            "hook_rate": round(hook_rate, 4),
            "hold_rate": round(survival, 4),
            "avg_play_time_sec": round(expected_watch, 2),
            "duration_sec": round(duration, 2),
        },
        "scroll": {
            "thumb_pause_prob": thumb,
            "scroll_stop_prob": scroll_stop,
            "first_impression_score": first_impression,
            "signals": [],
        },
        "conversion": {"conversion_score": conversion, "reasons": []},
        "tribe": {"segments": tribe_scores, "signals": []},
    }
