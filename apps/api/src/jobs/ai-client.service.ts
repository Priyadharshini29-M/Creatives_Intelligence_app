import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.validation';

export type MediaType = 'VIDEO' | 'IMAGE' | 'AUDIO';

export interface ProbeResult {
  mediaType: MediaType;
  // Video-only fields are null for IMAGE/AUDIO; duration is null for IMAGE
  // (a still has no runtime).
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
}

/** Frame payload sent to the AI service (its API speaks snake_case). */
export interface FrameDto {
  key: string;
  index: number;
  timestamp_sec: number;
  is_scene_start: boolean;
  brightness: number;
  dominant_color: string;
  motion_score: number;
  face_count: number;
  has_text: boolean;
}

/** Frame analysis returned by the AI service (serialized camelCase). */
export interface FrameResult {
  key: string;
  index: number;
  timestampSec: number;
  isSceneStart: boolean;
  brightness: number;
  dominantColor: string;
  motionScore: number;
  faceCount: number;
  hasText: boolean;
}

export interface RetentionPoint {
  timestamp: number;
  drop_prob: number;
  survival: number;
}

export interface TranscribeSegment {
  index: number;
  start_sec: number;
  end_sec: number;
  text: string;
  confidence: number | null;
}

/** Loud-moment detection over the audio track — the audio analog of the
 * per-frame motion score. See apps/ai/app/services/audio_spikes.py. */
export interface AudioSpikesResult {
  timeline: { timestamp_sec: number; energy: number }[];
  spike_count: number;
  spike_rate_per_10s: number;
  avg_energy: number;
  spike_score: number;
}

export interface TranscribeResult {
  language: string | null;
  full_text: string;
  segments: TranscribeSegment[];
  audio_spikes: AudioSpikesResult;
}

export interface CtaPhrase {
  text: string;
  pattern: string;
  start_sec: number | null;
  end_sec: number | null;
}

// ─────────────────────────────────────────────
// Parallel analyzers (Creative Intelligence pipeline) — response shapes
// mirror the Python services' plain dict returns verbatim (snake_case),
// since those endpoints have no response_model aliasing.
// ─────────────────────────────────────────────

export interface SceneAnalysis {
  frame_description: string;
  scene_and_object_read: string;
  layout: string;
  objects: string[];
}

export interface CopyAnalysis {
  text: string;
  cta: {
    detected: boolean;
    phrases: string[];
    has_pricing: boolean;
    has_urgency: boolean;
  };
  script: { frame_index: number; text: string }[];
}

export interface ColourAnalysis {
  palette: {
    base: string | null;
    support: string | null;
    accent: string | null;
  };
  balance: {
    base_share: number | null;
    support_share: number | null;
    accent_share: number | null;
    score: number | null;
  };
}

export interface SubjectAnalysis {
  placement: string;
  zone: string;
  object_presence: number;
  center_focus: number;
  // Real YOLOv8n (ultralytics) detections — see apps/ai's
  // subject/detector.py. Optional: older persisted records predate this
  // field and only have the 4 above.
  objects_detected?: { label: string; confidence: number }[];
  detector?: string;
}

export interface SalesEngineResult {
  copy_corrections: string[];
  roas: { estimate_pct: number; reasoning: string };
  claim_safety: { risk: string; flags: string[] };
}

export interface CopyQualityResult {
  spelling: number | null;
  grammar: number | null;
  logic: number | null;
  clarity: number | null;
  findings: string[];
}

export interface RegionalFitResult {
  cities: {
    city: string;
    state: string;
    language: string;
    fit_pct: number | null;
  }[];
  clusters: { state: string; description: string }[];
}

/** Combined output of the Python analysis facade (analyze_video). */
export interface AnalysisResult {
  /** False whenever the TRIBE head is still on random init weights — see
   * tribe_head/postprocess.py's `calibrated` flag. Callers must not present
   * scores as reliable when this is false. */
  calibrated?: boolean;
  transcript?: {
    keywords: string[];
    emotional_keywords: string[];
    cta_detected: boolean;
    cta_phrases: CtaPhrase[];
    word_count: number;
  };
  hook?: { score: number; issues: string[]; recommendations: string[] };
  sentiment?: { emotions: Record<string, number> };
  retention?: {
    timeline: RetentionPoint[];
    hook_rate: number | null;
    hold_rate: number | null;
    avg_play_time_sec: number | null;
    duration_sec: number | null;
  };
  scroll?: {
    thumb_pause_prob: number | null;
    scroll_stop_prob: number | null;
    first_impression_score: number | null;
    signals: string[];
  };
  conversion?: { conversion_score: number | null; reasons: string[] };
  tribe?: { segments: Record<string, number>; signals: string[] };
}

/** Thin HTTP client for the Python FastAPI AI service. */
@Injectable()
export class AiClientService {
  private readonly logger = new Logger(AiClientService.name);
  private readonly baseUrl: string;

  constructor(config: ConfigService<Env, true>) {
    this.baseUrl = config.get('AI_SERVICE_URL', { infer: true });
  }

  probe(sourceUrl: string, mediaType: MediaType): Promise<ProbeResult> {
    return this.post<ProbeResult>('/v1/videos/probe', {
      source_url: sourceUrl,
      media_type: mediaType,
    });
  }

  async frames(
    sourceUrl: string,
    uploads: { key: string; put_url: string }[],
  ): Promise<FrameResult[]> {
    const res = await this.post<{ frames: FrameResult[] } | FrameResult[]>(
      '/v1/videos/frames',
      { source_url: sourceUrl, uploads },
    );
    return Array.isArray(res) ? res : (res?.frames ?? []);
  }

  /** IMAGE media's counterpart to frames() — the source is the one frame. */
  extractImageFrame(
    sourceUrl: string,
    upload: { key: string; put_url: string },
  ): Promise<FrameResult> {
    return this.post<FrameResult>('/v1/videos/frames/image', {
      source_url: sourceUrl,
      upload,
    });
  }

  transcribe(sourceUrl: string): Promise<TranscribeResult> {
    return this.post<TranscribeResult>('/v1/videos/transcribe', {
      source_url: sourceUrl,
    });
  }

  // ─────────────────────────────────────────────
  // Parallel analyzers — all take the already-uploaded frames' presigned GET
  // URLs (see pipeline.processor.ts's presignFrameUrls), not the source
  // video/image itself.
  // ─────────────────────────────────────────────

  analyzeScene(frameUrls: string[]): Promise<SceneAnalysis> {
    return this.post<SceneAnalysis>('/v1/videos/analyze/scene', {
      frame_urls: frameUrls,
    });
  }

  analyzeCopy(frameUrls: string[]): Promise<CopyAnalysis> {
    return this.post<CopyAnalysis>('/v1/videos/analyze/copy', {
      frame_urls: frameUrls,
    });
  }

  analyzeColour(frameUrls: string[]): Promise<ColourAnalysis> {
    return this.post<ColourAnalysis>('/v1/videos/analyze/colour', {
      frame_urls: frameUrls,
    });
  }

  analyzeSubject(frameUrls: string[]): Promise<SubjectAnalysis> {
    return this.post<SubjectAnalysis>('/v1/videos/analyze/subject', {
      frame_urls: frameUrls,
    });
  }

  analyzeSales(
    frameUrls: string[],
    copyJson: unknown,
    tribeScores: unknown,
  ): Promise<SalesEngineResult> {
    return this.post<SalesEngineResult>('/v1/videos/analyze/sales', {
      frame_urls: frameUrls,
      copy_json: copyJson,
      tribe_scores: tribeScores,
    });
  }

  /** Approval Desk "Language Mode" panel — grades reviewer-pasted ad copy/
   * voiceover/overlay script (not the pipeline's own auto-OCR'd text).
   * On-demand, not part of the analyzer fan-out. */
  analyzeCopyQuality(
    text: string,
    languageMode: string,
  ): Promise<CopyQualityResult> {
    return this.post<CopyQualityResult>('/v1/videos/analyze/copy-quality', {
      text,
      language_mode: languageMode,
    });
  }

  /** Approval Desk "Regional & Language Fit" panel — reads the video's
   * already-detected text (OCR + transcript) and scores it against 8 fixed
   * South Indian cities. On-demand, not part of the analyzer fan-out. */
  analyzeRegionalFit(text: string): Promise<RegionalFitResult> {
    return this.post<RegionalFitResult>('/v1/videos/analyze/regional-fit', {
      text,
    });
  }

  analyze(body: {
    source_url?: string | null;
    frames?: FrameDto[];
    transcript_text?: string | null;
    transcript_segments?: {
      text: string;
      start_sec?: number;
      end_sec?: number;
    }[];
    audio_spike_score?: number | null;
  }): Promise<AnalysisResult> {
    return this.post<AnalysisResult>('/v1/videos/analyze', body);
  }

  /** Local-only transcript intelligence (keywords/CTA-phrase detection) —
   * skips analyze()'s network call to the flaky/slow third-party TRIBE v2
   * text endpoint (historically up to a 120s timeout) entirely. Use this
   * instead of analyze() whenever only AnalysisResult['transcript'] is
   * needed — i.e. VIDEO/IMAGE media, which score from the 4 parallel
   * analyzers, not that endpoint. */
  analyzeTranscript(body: {
    transcript_text?: string | null;
    transcript_segments?: {
      text: string;
      start_sec?: number;
      end_sec?: number;
    }[];
  }): Promise<NonNullable<AnalysisResult['transcript']>> {
    return this.post<NonNullable<AnalysisResult['transcript']>>(
      '/v1/videos/analyze/transcript',
      body,
    );
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      this.logger.error(
        `AI service ${path} failed: ${res.status} ${text.slice(0, 300)}`,
      );
      // Include a snippet of the actual response body (e.g. FastAPI's
      // {"detail": "..."} — often the real cause, like a Gemini 429 quota
      // message) in the thrown error, not just the bare status code. This
      // is what ends up in ProcessingJob.error, which was previously just
      // "AI service /v1/videos/analyze/scene returned 502" — accurate but
      // required grepping the raw process log to find out *why* it was a
      // 502 (rate limit vs. a real bug vs. something else entirely).
      let detail = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text) as { detail?: string };
        if (parsed.detail) detail = parsed.detail.slice(0, 200);
      } catch {
        // text wasn't JSON — fall back to the raw snippet above.
      }
      throw new Error(`AI service ${path} returned ${res.status}: ${detail}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      this.logger.error(
        `AI service ${path} returned non-JSON: ${text.slice(0, 200)}`,
      );
      throw new Error(`AI service ${path} returned a non-JSON response`);
    }
  }
}
