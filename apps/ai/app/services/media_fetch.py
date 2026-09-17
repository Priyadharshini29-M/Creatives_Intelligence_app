"""Shared frame/image download helper for the parallel analyzer services
(OCR, color, subject, vision, sales-engine) — all of them read the same
already-uploaded frame JPEGs the frame-extraction step produced (or, for
IMAGE media, the single source image), rather than re-downloading/decoding
the source video themselves."""

from __future__ import annotations

import cv2
import httpx
import numpy as np

_DOWNLOAD_TIMEOUT_SEC = 30.0


class MediaFetchError(RuntimeError):
    """Raised when a frame/image URL can't be downloaded or decoded."""


def fetch_bytes(url: str) -> bytes:
    try:
        response = httpx.get(url, timeout=_DOWNLOAD_TIMEOUT_SEC)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise MediaFetchError(f"Frame download failed: {exc}") from exc
    return response.content


def fetch_image(url: str) -> np.ndarray:
    """Decode a frame/image URL to a BGR OpenCV array."""
    data = fetch_bytes(url)
    array = np.frombuffer(data, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        raise MediaFetchError("Could not decode image data")
    return image


def select_representative(urls: list[str], count: int) -> list[str]:
    """Evenly-spaced pick including the first and last URL — caps how many
    frames get sent to per-frame-costly analyzers (Gemini, OCR) regardless
    of how many frames the extraction step sampled."""
    if len(urls) <= count:
        return list(urls)
    if count <= 1:
        return [urls[0]]
    step = (len(urls) - 1) / (count - 1)
    indices = sorted({round(i * step) for i in range(count)})
    return [urls[i] for i in indices]
