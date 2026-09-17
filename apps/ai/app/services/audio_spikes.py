"""Audio energy/spike analysis — detects loud moments (sound effects, music
hits, shouted words, sudden emphasis) the same way frames.py's motion score
detects visual activity spikes, but for the audio track.

Reuses the mono 16kHz WAV that transcribe.py already extracts for Whisper —
this module never downloads or decodes the source itself, it just reads the
same temp file before it's cleaned up.
"""

from __future__ import annotations

import wave
from dataclasses import dataclass

import numpy as np

_WINDOW_SEC = 0.5

# A window counts as a "spike" when its RMS energy exceeds this multiple of
# the clip's own mean energy. Adaptive per-clip rather than an absolute
# threshold, since raw loudness varies wildly with recording level/compression.
_SPIKE_THRESHOLD_MULTIPLIER = 1.5

# Silence floor — windows quieter than this never count as spikes even if
# they exceed the (near-zero) mean of an already-quiet clip.
_MIN_SPIKE_ENERGY = 0.01

# Spike rate (per 10s) that maps to a fully "energetic" 1.0 score — tuned as
# a reasonable upper bound for a busy, sound-effect-heavy short-form edit.
_FULLY_ENERGETIC_SPIKES_PER_10S = 6.0


@dataclass(frozen=True)
class AudioEnergyPoint:
    timestamp_sec: float
    energy: float  # 0-1, RMS relative to full 16-bit scale


@dataclass(frozen=True)
class AudioSpikeAnalysis:
    timeline: list[AudioEnergyPoint]
    spike_count: int
    spike_rate_per_10s: float
    avg_energy: float
    # 0-1, same scale as frames.py's motion_score so the two can blend.
    spike_score: float


EMPTY = AudioSpikeAnalysis(
    timeline=[], spike_count=0, spike_rate_per_10s=0.0, avg_energy=0.0, spike_score=0.0
)


def analyze(wav_path: str) -> AudioSpikeAnalysis:
    """``wav_path``: mono PCM WAV, as produced by transcribe.py's
    ``_extract_audio``. Returns the neutral/empty analysis for a silent
    clip (zero-byte WAV) rather than raising — silence is a valid outcome."""
    with wave.open(wav_path, "rb") as wf:
        n_channels = wf.getnchannels()
        sample_width = wf.getsampwidth()
        framerate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)

    if n_frames == 0 or sample_width != 2 or framerate <= 0:
        return EMPTY

    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1)

    window_size = max(1, int(_WINDOW_SEC * framerate))
    n_windows = len(samples) // window_size
    if n_windows == 0:
        return EMPTY

    energies = [
        float(np.sqrt(np.mean(samples[i * window_size : (i + 1) * window_size] ** 2))) / 32768.0
        for i in range(n_windows)
    ]

    mean_energy = sum(energies) / len(energies)
    threshold = mean_energy * _SPIKE_THRESHOLD_MULTIPLIER

    timeline = [
        AudioEnergyPoint(timestamp_sec=round(i * _WINDOW_SEC, 2), energy=round(e, 4))
        for i, e in enumerate(energies)
    ]
    spike_count = sum(1 for e in energies if e > threshold and e > _MIN_SPIKE_ENERGY)

    duration_sec = n_windows * _WINDOW_SEC
    spike_rate_per_10s = round((spike_count / duration_sec) * 10, 3) if duration_sec > 0 else 0.0
    spike_score = round(min(1.0, spike_rate_per_10s / _FULLY_ENERGETIC_SPIKES_PER_10S), 4)

    return AudioSpikeAnalysis(
        timeline=timeline,
        spike_count=spike_count,
        spike_rate_per_10s=spike_rate_per_10s,
        avg_energy=round(mean_energy, 4),
        spike_score=spike_score,
    )
