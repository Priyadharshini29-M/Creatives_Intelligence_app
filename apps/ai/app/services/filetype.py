"""File-type probing for non-video media (Creative Intelligence pipeline).

ffprobe.py already handles VIDEO (requires a video stream, raises otherwise);
this module covers the other two media types for the same /v1/videos/probe
endpoint:
  - IMAGE: dimension read via PIL.
  - AUDIO: duration/codec via ffprobe's audio stream.

Which function runs is decided by the media type the orchestrator already
knows from the Video row (set at upload time — see
apps/api/src/videos/videos.service.ts's createUploadUrl), not by re-sniffing
file content here. The upload step's mime/extension check is the source of
truth for what kind of file this is; full content-based type-mismatch
detection (does the file's actual bytes match what the client claimed) is a
possible future hardening, not implemented now.
"""

from __future__ import annotations

import asyncio
import io
import json
import subprocess
from dataclasses import dataclass

import httpx
from PIL import Image

from app.config import settings


class FileTypeError(RuntimeError):
    """Raised when an image/audio source cannot be read."""


@dataclass(frozen=True)
class ImageInfo:
    width: int
    height: int
    format: str


@dataclass(frozen=True)
class AudioInfo:
    duration_sec: float
    codec: str


async def probe_image(source_url: str) -> ImageInfo:
    return await asyncio.to_thread(_probe_image_sync, source_url)


def _probe_image_sync(source_url: str) -> ImageInfo:
    try:
        with httpx.Client(timeout=settings.probe_timeout_sec) as client:
            response = client.get(source_url)
            response.raise_for_status()
        image = Image.open(io.BytesIO(response.content))
        image.load()
    except Exception as exc:
        raise FileTypeError(f"Could not read image source: {exc}") from exc
    return ImageInfo(width=image.width, height=image.height, format=str(image.format or "unknown"))


def _run_ffprobe(source_url: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [
            settings.ffprobe_bin,
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            source_url,
        ],
        capture_output=True,
        timeout=settings.probe_timeout_sec,
    )


async def probe_audio(source_url: str) -> AudioInfo:
    # Blocking subprocess in a worker thread — same reason as ffprobe.probe:
    # uvicorn's Windows event loop has no subprocess support.
    try:
        proc = await asyncio.to_thread(_run_ffprobe, source_url)
    except subprocess.TimeoutExpired as exc:
        raise FileTypeError("ffprobe timed out reading the audio source") from exc
    except OSError as exc:
        raise FileTypeError(f"ffprobe could not be executed: {exc}") from exc

    if proc.returncode != 0:
        raise FileTypeError(
            f"ffprobe failed: {proc.stderr.decode(errors='replace').strip()}"
        )

    data = json.loads(proc.stdout)
    audio_stream = next(
        (s for s in data.get("streams", []) if s.get("codec_type") == "audio"),
        None,
    )
    if audio_stream is None:
        raise FileTypeError("Source contains no audio stream")

    duration = float(
        audio_stream.get("duration") or data.get("format", {}).get("duration") or 0
    )
    return AudioInfo(duration_sec=duration, codec=str(audio_stream.get("codec_name", "unknown")))
