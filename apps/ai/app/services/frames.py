"""Frame extraction + visual analysis (Phase 2).

Downloads the source video to a temp file, samples one frame per upload
target the orchestrator presigned, analyzes each with OpenCV, and PUTs the
JPEGs straight to object storage. This service holds no storage credentials —
the presigned URLs are the only write access it ever has.

Signals per frame:
  - scene start   : HSV histogram distance vs. the previous sampled frame
  - brightness    : mean luma, normalized 0–1
  - motion score  : mean absolute grayscale difference vs. previous frame, 0–1
  - dominant color: largest k-means cluster over a downscaled frame, hex
  - face count    : Haar cascade (frontal faces)
  - has text      : morphological-gradient heuristic — flags overlay-caption-like
                    regions; real OCR arrives with a later phase
"""

import os
import tempfile
from dataclasses import dataclass
from urllib.parse import urlparse

import cv2
import httpx
import numpy as np

from app.config import settings


class FrameExtractionError(RuntimeError):
    """Raised when the source cannot be downloaded, decoded, or stored."""


@dataclass(frozen=True)
class FrameAnalysis:
    key: str
    index: int
    timestamp_sec: float
    is_scene_start: bool
    brightness: float
    dominant_color: str
    motion_score: float
    face_count: int
    has_text: bool


@dataclass(frozen=True)
class UploadTarget:
    key: str
    put_url: str


# Bhattacharyya distance above which two consecutive sampled frames are
# considered different scenes. Tuned for 1-frame-per-second sampling, where
# ordinary in-scene motion already produces moderate distances.
_SCENE_DISTANCE_THRESHOLD = 0.45

_face_cascade = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)


def extract_and_upload_image(source_url: str, upload: UploadTarget) -> FrameAnalysis:
    """IMAGE media's counterpart to extract_and_upload: the source *is* the
    single frame — no sampling, no motion/scene-start (both undefined for a
    still), but the same brightness/dominant-color/face-count/has-text
    heuristics apply unchanged. Re-uploads the source bytes as JPEG to the
    frame's storage slot so downstream analyzers (Milestone 2) can read a
    Frame row exactly as they would for VIDEO."""
    data = _download_bytes(source_url)
    array = np.frombuffer(data, dtype=np.uint8)
    frame = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if frame is None:
        raise FrameExtractionError("Could not decode image source")

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    with httpx.Client(timeout=settings.frames_upload_timeout_sec) as client:
        _upload_jpeg(client, upload.put_url, frame)

    return FrameAnalysis(
        key=upload.key,
        index=0,
        timestamp_sec=0.0,
        is_scene_start=True,
        brightness=round(float(np.mean(gray)) / 255.0, 4),
        dominant_color=_dominant_color(frame),
        motion_score=0.0,
        face_count=_count_faces(gray),
        has_text=_looks_like_text(gray),
    )


def _download_bytes(source_url: str) -> bytes:
    last_error: Exception | None = None
    for attempt in range(1, _DOWNLOAD_ATTEMPTS + 1):
        try:
            with httpx.Client(timeout=settings.frames_download_timeout_sec) as client:
                response = client.get(source_url)
                if response.status_code >= 400:
                    raise FrameExtractionError(
                        f"Source download failed with HTTP {response.status_code}"
                    )
                expected_length = response.headers.get("content-length")
                if expected_length is not None and len(response.content) != int(
                    expected_length
                ):
                    raise FrameExtractionError(
                        f"Source download truncated: got {len(response.content)} bytes, "
                        f"expected {expected_length}"
                    )
                return response.content
        except (httpx.HTTPError, FrameExtractionError) as exc:
            last_error = exc
            if attempt < _DOWNLOAD_ATTEMPTS:
                continue
    raise FrameExtractionError(str(last_error))


def extract_and_upload(source_url: str, uploads: list[UploadTarget]) -> list[FrameAnalysis]:
    """Sample len(uploads) frames evenly across the video, analyze each, and
    upload the JPEGs to the presigned targets. The upload list is the sampling
    budget — the orchestrator decides how many frames a video deserves."""
    suffix = os.path.splitext(urlparse(source_url).path)[1] or ".mp4"
    fd, temp_path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    try:
        _download(source_url, temp_path)
        return _process(temp_path, uploads)
    finally:
        try:
            os.unlink(temp_path)
        except OSError:
            pass


# Local dev routes the source through a free tunnel (ngrok/cloudflared) to
# make it reachable from Modal — those drop connections under load without
# any error surfacing at the HTTP layer, silently truncating the file
# instead of failing the request. One retry recovers most of those; verifying
# the byte count against Content-Length (when present) catches the rest
# before a truncated file reaches OpenCV as a confusing "could not open".
_DOWNLOAD_ATTEMPTS = 2


def _download(source_url: str, dest_path: str) -> None:
    last_error: Exception | None = None
    for attempt in range(1, _DOWNLOAD_ATTEMPTS + 1):
        try:
            _download_once(source_url, dest_path)
            return
        except FrameExtractionError as exc:
            last_error = exc
            if attempt < _DOWNLOAD_ATTEMPTS:
                continue
    raise last_error  # type: ignore[misc]


def _download_once(source_url: str, dest_path: str) -> None:
    try:
        with httpx.Client(timeout=settings.frames_download_timeout_sec) as client:
            with client.stream("GET", source_url) as response:
                if response.status_code >= 400:
                    raise FrameExtractionError(
                        f"Source download failed with HTTP {response.status_code}"
                    )
                expected_length = response.headers.get("content-length")
                received = 0
                with open(dest_path, "wb") as fh:
                    for chunk in response.iter_bytes():
                        fh.write(chunk)
                        received += len(chunk)
    except httpx.HTTPError as exc:
        raise FrameExtractionError(f"Source download failed: {exc}") from exc

    if expected_length is not None and received != int(expected_length):
        raise FrameExtractionError(
            f"Source download truncated: got {received} bytes, expected {expected_length}"
        )


def _process(video_path: str, uploads: list[UploadTarget]) -> list[FrameAnalysis]:
    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        raise FrameExtractionError("OpenCV could not open the downloaded source")

    try:
        fps = capture.get(cv2.CAP_PROP_FPS) or 0
        total_frames = capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0
        duration = total_frames / fps if fps > 0 else 0
        if duration <= 0:
            raise FrameExtractionError("Source reports no readable duration")

        results: list[FrameAnalysis] = []
        prev_gray: np.ndarray | None = None
        prev_hist: np.ndarray | None = None

        with httpx.Client(timeout=settings.frames_upload_timeout_sec) as client:
            for i, target in enumerate(uploads):
                # Midpoint sampling avoids the black first frame and the
                # truncated last one.
                timestamp = (i + 0.5) * duration / len(uploads)
                capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000)
                ok, frame = capture.read()
                if not ok or frame is None:
                    continue  # unreadable point (e.g. past a truncated tail)

                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                small_gray = cv2.resize(gray, (160, 90))
                hist = _hsv_histogram(frame)

                motion = 0.0
                is_scene_start = True
                if prev_gray is not None:
                    motion = float(
                        np.mean(cv2.absdiff(small_gray, prev_gray)) / 255.0
                    )
                if prev_hist is not None:
                    distance = cv2.compareHist(
                        prev_hist, hist, cv2.HISTCMP_BHATTACHARYYA
                    )
                    is_scene_start = distance > _SCENE_DISTANCE_THRESHOLD
                prev_gray, prev_hist = small_gray, hist

                _upload_jpeg(client, target.put_url, frame)

                results.append(
                    FrameAnalysis(
                        key=target.key,
                        index=len(results),
                        timestamp_sec=round(timestamp, 3),
                        is_scene_start=is_scene_start,
                        brightness=round(float(np.mean(gray)) / 255.0, 4),
                        dominant_color=_dominant_color(frame),
                        motion_score=round(motion, 4),
                        face_count=_count_faces(gray),
                        has_text=_looks_like_text(gray),
                    )
                )

        if not results:
            raise FrameExtractionError("No frames could be decoded from the source")
        return results
    finally:
        capture.release()


def _upload_jpeg(client: httpx.Client, put_url: str, frame: np.ndarray) -> None:
    ok, encoded = cv2.imencode(
        ".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, settings.frames_jpeg_quality]
    )
    if not ok:
        raise FrameExtractionError("JPEG encoding failed")
    try:
        response = client.put(
            put_url,
            content=encoded.tobytes(),
            headers={"Content-Type": "image/jpeg"},
        )
    except httpx.HTTPError as exc:
        raise FrameExtractionError(f"Frame upload failed: {exc}") from exc
    if response.status_code >= 300:
        raise FrameExtractionError(
            f"Frame upload rejected with HTTP {response.status_code}"
        )


def _hsv_histogram(frame: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(cv2.resize(frame, (160, 90)), cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], None, [32, 32], [0, 180, 0, 256])
    cv2.normalize(hist, hist)
    return hist


def _dominant_color(frame: np.ndarray) -> str:
    pixels = (
        cv2.resize(frame, (64, 64)).reshape(-1, 3).astype(np.float32)
    )
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 10, 1.0)
    _, labels, centers = cv2.kmeans(
        pixels, 3, None, criteria, 3, cv2.KMEANS_PP_CENTERS
    )
    dominant = centers[np.bincount(labels.flatten()).argmax()]
    b, g, r = (int(round(c)) for c in dominant)
    return f"#{r:02x}{g:02x}{b:02x}"


def _count_faces(gray: np.ndarray) -> int:
    if _face_cascade.empty():
        return 0
    height = gray.shape[0]
    try:
        faces = _face_cascade.detectMultiScale(
            gray,
            scaleFactor=1.1,
            minNeighbors=5,
            minSize=(max(24, height // 12), max(24, height // 12)),
        )
    except cv2.error:
        # Face count is a soft signal — a cascade failure on an unusual frame
        # size must not fail the whole extraction step.
        return 0
    return len(faces)


def _looks_like_text(gray: np.ndarray) -> bool:
    """Overlay captions and title cards produce clusters of wide, short,
    high-contrast regions after a morphological gradient. Counts such regions
    rather than reading them — cheap and dependency-free."""
    height, width = gray.shape
    gradient = cv2.morphologyEx(
        gray, cv2.MORPH_GRADIENT, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    )
    _, binary = cv2.threshold(gradient, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    connected = cv2.morphologyEx(
        binary, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (13, 1))
    )
    contours, _ = cv2.findContours(
        connected, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )

    text_like = 0
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if h == 0:
            continue
        aspect = w / h
        if (
            aspect > 2.5
            and 0.01 * height < h < 0.12 * height
            and w > 0.05 * width
        ):
            # Text strokes fill a moderate fraction of their box; solid bars
            # and thin edges fall outside this band.
            fill = cv2.countNonZero(binary[y : y + h, x : x + w]) / (w * h)
            if 0.15 < fill < 0.95:
                text_like += 1
    return text_like >= 2
