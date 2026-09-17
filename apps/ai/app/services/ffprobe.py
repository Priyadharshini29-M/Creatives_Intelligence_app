"""Media metadata extraction via ffprobe.

ffprobe reads presigned HTTP(S) URLs directly, so sources never have to be
downloaded to disk just to read their metadata.
"""

import asyncio
import json
import subprocess
from dataclasses import dataclass

from app.config import settings


class ProbeError(RuntimeError):
    """Raised when a source cannot be probed."""


@dataclass(frozen=True)
class MediaInfo:
    duration_sec: float
    width: int
    height: int
    fps: float
    codec: str


def _parse_frame_rate(raw: str) -> float:
    """ffprobe reports rates as fractions like '30000/1001'."""
    if "/" in raw:
        num, _, den = raw.partition("/")
        denominator = float(den)
        return float(num) / denominator if denominator else 0.0
    return float(raw or 0)


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


async def probe(source_url: str) -> MediaInfo:
    # Blocking subprocess in a worker thread rather than
    # asyncio.create_subprocess_exec: the selector event loop uvicorn uses on
    # Windows has no subprocess support (raises NotImplementedError).
    try:
        proc = await asyncio.to_thread(_run_ffprobe, source_url)
    except subprocess.TimeoutExpired as exc:
        raise ProbeError("ffprobe timed out reading the source") from exc
    except OSError as exc:
        raise ProbeError(f"ffprobe could not be executed: {exc}") from exc

    if proc.returncode != 0:
        raise ProbeError(
            f"ffprobe failed: {proc.stderr.decode(errors='replace').strip()}"
        )

    data = json.loads(proc.stdout)
    video_stream = next(
        (s for s in data.get("streams", []) if s.get("codec_type") == "video"),
        None,
    )
    if video_stream is None:
        raise ProbeError("Source contains no video stream")

    duration = float(
        video_stream.get("duration")
        or data.get("format", {}).get("duration")
        or 0
    )

    return MediaInfo(
        duration_sec=duration,
        width=int(video_stream.get("width", 0)),
        height=int(video_stream.get("height", 0)),
        fps=_parse_frame_rate(video_stream.get("r_frame_rate", "0")),
        codec=str(video_stream.get("codec_name", "unknown")),
    )
