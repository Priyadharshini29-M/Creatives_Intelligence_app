from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """AI service configuration. Values come from apps/ai/.env or the shell."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: str = "development"
    ffprobe_bin: str = "ffprobe"
    ffmpeg_bin: str = "ffmpeg"
    # Probe timeout for remote (presigned URL) sources.
    probe_timeout_sec: float = 60.0

    # Frame extraction (Phase 2)
    frames_download_timeout_sec: float = 180.0
    frames_upload_timeout_sec: float = 30.0
    frames_jpeg_quality: int = 85

    # Transcription (Phase 3) — faster-whisper on CPU. Tried "small" for
    # better non-English accuracy (see tribe_v2/client.py's degenerate-text
    # guard for the "base" hallucination problem this was meant to fix) —
    # reverted: on this machine it took 13+ minutes on a 34s clip (confirmed
    # genuinely computing the whole time, not hung — 1548 CPU-seconds
    # across multiple cores) instead of "base"'s ~5-8s. That's a much worse
    # regression than the hallucination it was meant to prevent; the
    # degenerate-text guard downstream is the right fix for that instead.
    # Dropped one more tier to "tiny" (2026-09-09, explicit user priority:
    # speed over transcript accuracy) — noticeably faster than "base" on
    # this CPU-only setup, at the cost of more transcription errors on
    # accented/vernacular speech. Only the transcript-derived signals
    # (keywords, CTA-phrase detection, the legacy AUDIO-only scoring path)
    # are affected — the Creative Intelligence pipeline's real Tribe v2
    # scores (Vision/OCR/Color/Subject → scoring engine) don't read
    # transcript text at all, so this trade only costs accuracy where
    # speech content itself is being read. Revert to "base" if transcript
    # quality complaints show up.
    whisper_model: str = "tiny"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"
    transcribe_timeout_sec: float = 600.0
    # Greedy decoding: ~3-5x faster than beam search on CPU with negligible
    # quality loss on short marketing clips. Raise for long-form accuracy.
    whisper_beam_size: int = 1
    # Tried False (faster-whisper's default is True) to fight the
    # repetition-loop hallucination seen on this project's hardest Tamil
    # clip — reverted. It did stop the tight repeat-loop, but on that same
    # clip cost ~150s instead of ~5-8s and just produced a different kind
    # of garbage (incoherent mixed-script word salad) instead of real text.
    # That clip's audio appears to be genuinely too hard for this CPU setup
    # to transcribe reliably at any size/setting tried so far — the
    # degenerate-text guard in tribe_v2/client.py is the practical backstop
    # for whichever hallucination shape gets through, not a model-side knob.
    whisper_condition_on_previous_text: bool = True
    # 0 = use all available cores (faster-whisper defaults to 4).
    whisper_cpu_threads: int = 0

    # TRIBE v2 (Modal-hosted) — Phase 4, the platform's only video-analysis
    # model. See modal_service/README.md for deployment.
    tribe_modal_app_name: str = "tribe-v2-inference"
    tribe_modal_class_name: str = "TribeV2Model"

    # Parallel analyzers (Creative Intelligence pipeline) — OCR module.
    # Must point at a real Tesseract install; pytesseract only shells out to
    # it, it doesn't vendor the binary.
    tesseract_bin: str = "tesseract"

    # Parallel analyzers — the two Gemini calls (Vision scene-read,
    # sales-engine copy/ROAS/claim-safety). Empty by default: both services
    # raise a clear error rather than silently no-op-ing when unset.
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.5-flash"

    # Parallel analyzers — subject/object detector. Real YOLOv8n (ultralytics,
    # COCO 80-class), replacing the earlier Haar-cascade-only face detector
    # (see subject/detector.py's module docstring for why: Haar-cascade could
    # only ever find faces, so a pure product-shot ad with no person in frame
    # always returned "unknown"). `nano` variant chosen for CPU-only inference
    # speed on this pipeline's per-frame analysis path, not accuracy — same
    # tradeoff whisper_model=tiny already makes elsewhere in this file.
    yolo_model_path: str = "models/yolov8n.pt"
    yolo_confidence_min: float = 0.35


settings = Settings()
