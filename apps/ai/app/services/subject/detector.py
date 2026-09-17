"""Face/subject detector (parallel analyzer 4 of 4) — real object detection
via YOLOv8n (ultralytics, COCO 80-class), replacing the earlier Haar-cascade
-only face detector.

Why the swap: Haar-cascade could only ever find *faces* — a pure
product-shot ad with no person in frame (very common for D2C creatives)
always returned "unknown" for placement/zone/object_presence, silently
dropping the whole signal for a large share of real ads. YOLO detects all
80 COCO classes (person, bottle, cup, handbag, cell phone, etc.), so a
product-only frame now genuinely contributes a subject-placement reading
instead of nothing.

The {placement, zone, object_presence, center_focus} output contract is
UNCHANGED from the previous Haar-cascade version on purpose — tribe-scoring.ts's
computeTribeScores() and every UI consumer read those same 4 fields and need
no changes; only this file's internals got a real detector. `objects_detected`
is new and additive (a plain list of {label, confidence}) — surfaced on the
Approval Desk's asset overview so it's visible this is genuine detection
output, not a re-labeled heuristic.
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np
from ultralytics import YOLO

from app.config import settings
from app.services.media_fetch import MediaFetchError, fetch_image, select_representative

_MAX_FRAMES = 6


@lru_cache(maxsize=1)
def _model() -> YOLO:
    # Loaded once per worker process and cached — model load (deserializing
    # the .pt checkpoint) is the expensive part, not a single inference call.
    return YOLO(settings.yolo_model_path)


def analyze_subject(frame_urls: list[str]) -> dict:
    if not frame_urls:
        return _empty_result()

    targets = select_representative(frame_urls, _MAX_FRAMES)
    placements: list[str] = []
    zones: list[str] = []
    center_focus_scores: list[float] = []
    frames_with_subject = 0
    detections_by_label: dict[str, float] = {}  # label -> best confidence seen

    for url in targets:
        try:
            image = fetch_image(url)
        except MediaFetchError:
            continue
        placement, zone, center_focus, has_subject, frame_detections = _classify_frame(image)
        center_focus_scores.append(center_focus)
        for label, conf in frame_detections:
            detections_by_label[label] = max(detections_by_label.get(label, 0.0), conf)
        if has_subject:
            frames_with_subject += 1
            placements.append(placement)
            zones.append(zone)

    total = len(targets)
    objects_detected = [
        {"label": label, "confidence": round(conf, 4)}
        for label, conf in sorted(detections_by_label.items(), key=lambda kv: -kv[1])
    ]
    return {
        "placement": _most_common(placements) or "unknown",
        "zone": _most_common(zones) or "unknown",
        "object_presence": round(frames_with_subject / total, 4) if total else 0.0,
        "center_focus": round(float(np.mean(center_focus_scores)), 4)
        if center_focus_scores
        else 0.0,
        "objects_detected": objects_detected,
        "detector": "yolov8n",
    }


def _classify_frame(
    image: np.ndarray,
) -> tuple[str, str, float, bool, list[tuple[str, float]]]:
    height, width = image.shape[:2]
    results = _model()(image, verbose=False, conf=settings.yolo_confidence_min)[0]

    frame_detections: list[tuple[str, float]] = []
    boxes = []
    for box in results.boxes:
        label = results.names[int(box.cls[0])]
        conf = float(box.conf[0])
        frame_detections.append((label, conf))
        boxes.append((conf, box.xyxy[0].tolist()))

    if not boxes:
        return "unknown", "unknown", 0.0, False, frame_detections

    # Highest-confidence detection stands in for "the subject" — the
    # equivalent of the old code's "largest face wins", generalized to any
    # of the 80 COCO classes instead of faces only.
    _, (x1, y1, x2, y2) = max(boxes, key=lambda b: b[0])
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2

    placement = "top" if cy < height / 3 else "bottom" if cy > 2 * height / 3 else "middle"
    zone = "left" if cx < width / 3 else "right" if cx > 2 * width / 3 else "center"

    # 1.0 at dead-center, falling off toward the frame edges — unchanged
    # formula from the Haar-cascade version, just fed a YOLO bbox center now.
    center_focus = 1.0 - min(
        1.0,
        (abs(cx - width / 2) / (width / 2) + abs(cy - height / 2) / (height / 2)) / 2,
    )
    return placement, zone, float(center_focus), True, frame_detections


def _most_common(values: list[str]) -> str | None:
    if not values:
        return None
    return max(set(values), key=values.count)


def _empty_result() -> dict:
    return {
        "placement": "unknown",
        "zone": "unknown",
        "object_presence": 0.0,
        "center_focus": 0.0,
        "objects_detected": [],
        "detector": "yolov8n",
    }
