"""Speech-to-text via faster-whisper (Phase 3).

Extracts a mono 16 kHz WAV from the source with ffmpeg (reading the presigned
URL directly), then runs Whisper locally. The model is loaded lazily and cached
for the process lifetime — first request pays the model download/load cost.
"""

import os
import subprocess
import tempfile
import threading
from dataclasses import dataclass

from app.config import settings
from app.services import audio_spikes
from app.services.audio_spikes import AudioSpikeAnalysis


class TranscriptionError(RuntimeError):
    """Raised when audio extraction or transcription fails."""


@dataclass(frozen=True)
class TranscriptSegment:
    index: int
    start_sec: float
    end_sec: float
    text: str
    confidence: float | None


@dataclass(frozen=True)
class TranscriptionResult:
    language: str | None
    full_text: str
    segments: list[TranscriptSegment]
    audio_spikes: AudioSpikeAnalysis


@dataclass(frozen=True)
class _WhisperResult:
    language: str | None
    full_text: str
    segments: list[TranscriptSegment]


_model_lock = threading.Lock()
_model = None

# Guards actual .transcribe() calls (loading the model already has its own
# lock, but that only covers the one-time load). WhisperModel is configured
# with cpu_threads pinned to all available cores per call — two concurrent
# transcriptions fight over the same cores instead of each getting full
# throughput, which showed up as one request stalling for minutes while a
# sibling request (same machine, same moment) ran. Serializing keeps each
# transcription at its normal ~4-8s instead of both degrading badly; queued
# requests wait their turn rather than starving.
_inference_lock = threading.Lock()


def _get_model():
    """Lazy singleton — loading Whisper takes seconds and must happen once."""
    global _model
    with _model_lock:
        if _model is None:
            import os

            from faster_whisper import WhisperModel

            _model = WhisperModel(
                settings.whisper_model,
                device=settings.whisper_device,
                compute_type=settings.whisper_compute_type,
                cpu_threads=settings.whisper_cpu_threads or (os.cpu_count() or 4),
            )
        return _model


def warm_up() -> None:
    """Preload the model so the first transcription doesn't pay the load cost.
    Called from a background thread at service startup."""
    _get_model()


def transcribe(source_url: str) -> TranscriptionResult:
    fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        _extract_audio(source_url, wav_path)
        if os.path.getsize(wav_path) == 0:
            # Video without an audio track — a valid outcome, not an error.
            return TranscriptionResult(
                language=None, full_text="", segments=[], audio_spikes=audio_spikes.EMPTY
            )
        # Same WAV feeds both Whisper and the energy-spike analysis — one
        # ffmpeg extraction, not two.
        spikes = audio_spikes.analyze(wav_path)
        result = _run_whisper(wav_path)
        return TranscriptionResult(
            language=result.language,
            full_text=result.full_text,
            segments=result.segments,
            audio_spikes=spikes,
        )
    finally:
        try:
            os.unlink(wav_path)
        except OSError:
            pass


# Local dev routes the source through a free tunnel (ngrok/cloudflared) to
# make it reachable from Modal — those drop connections under load, which
# ffmpeg surfaces as a transient decode failure. One retry recovers most of
# those without giving up on a video that's actually fine.
_EXTRACT_ATTEMPTS = 2


def _extract_audio(source_url: str, wav_path: str) -> None:
    last_error: TranscriptionError | None = None
    for attempt in range(1, _EXTRACT_ATTEMPTS + 1):
        try:
            _extract_audio_once(source_url, wav_path)
            return
        except TranscriptionError as exc:
            last_error = exc
            if attempt < _EXTRACT_ATTEMPTS:
                continue
    raise last_error  # type: ignore[misc]


def _extract_audio_once(source_url: str, wav_path: str) -> None:
    try:
        proc = subprocess.run(
            [
                settings.ffmpeg_bin,
                "-y",
                "-i", source_url,
                "-vn",
                "-ac", "1",
                "-ar", "16000",
                "-f", "wav",
                wav_path,
            ],
            capture_output=True,
            timeout=settings.transcribe_timeout_sec,
        )
    except subprocess.TimeoutExpired as exc:
        raise TranscriptionError("ffmpeg timed out extracting audio") from exc
    except OSError as exc:
        raise TranscriptionError(f"ffmpeg could not be executed: {exc}") from exc

    if proc.returncode != 0:
        stderr = proc.stderr.decode(errors="replace")
        # No audio stream is a normal case for silent clips: ffmpeg errors
        # with "does not contain any stream" / "Output file #0 does not
        # contain any stream".
        if "does not contain any stream" in stderr:
            with open(wav_path, "wb"):
                pass  # truncate to empty → treated as silent upstream
            return
        raise TranscriptionError(f"ffmpeg failed: {stderr.strip()[-400:]}")


# Without VAD, Whisper hallucinates filler on silence/music. Segments whose
# no-speech probability exceeds this are dropped in the no-VAD fallback.
_NO_SPEECH_THRESHOLD = 0.5


def _run_whisper(wav_path: str) -> _WhisperResult:
    with _inference_lock:
        return _run_whisper_locked(wav_path)


def _run_whisper_locked(wav_path: str) -> _WhisperResult:
    try:
        try:
            segments_iter, info = _get_model().transcribe(
                wav_path,
                vad_filter=True,
                beam_size=settings.whisper_beam_size,
                condition_on_previous_text=settings.whisper_condition_on_previous_text,
            )
            vad_used = True
        except RuntimeError:
            # The Silero VAD needs onnxruntime, whose native DLL fails to
            # load on some Windows machines ("paging file too small").
            # Fall back to raw decoding + a hallucination guard.
            segments_iter, info = _get_model().transcribe(
                wav_path,
                vad_filter=False,
                beam_size=settings.whisper_beam_size,
                condition_on_previous_text=settings.whisper_condition_on_previous_text,
            )
            vad_used = False

        segments: list[TranscriptSegment] = []
        for seg in segments_iter:
            text = seg.text.strip()
            if not text:
                continue
            no_speech = float(getattr(seg, "no_speech_prob", 0.0) or 0.0)
            if not vad_used and no_speech > _NO_SPEECH_THRESHOLD:
                continue
            segments.append(
                TranscriptSegment(
                    index=len(segments),
                    start_sec=round(float(seg.start), 3),
                    end_sec=round(float(seg.end), 3),
                    text=text,
                    confidence=(
                        round(float(seg.avg_logprob), 4)
                        if seg.avg_logprob is not None
                        else None
                    ),
                )
            )
    except Exception as exc:  # faster-whisper raises plain RuntimeError et al.
        raise TranscriptionError(f"Whisper inference failed: {exc}") from exc

    return _WhisperResult(
        language=getattr(info, "language", None) if segments else None,
        full_text=" ".join(s.text for s in segments),
        segments=segments,
    )
