import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  JobStatus,
  JobType,
  MediaType,
  NotificationType,
  Prisma,
  PredictionKind,
  RecommendationKind,
  VideoStatus,
} from '@vip/database';
import { Job } from 'bullmq';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { RulesService } from '../rules/rules.service';
import { S3Service } from '../storage/s3.service';
import {
  AiClientService,
  AnalysisResult,
  ColourAnalysis,
  CopyAnalysis,
  FrameDto,
  SceneAnalysis,
  SubjectAnalysis,
} from './ai-client.service';
import { JobsService } from './jobs.service';
import {
  ANALYZER_FANOUT_STEPS,
  PipelineJobData,
  PipelineStep,
  VIDEO_PIPELINE_QUEUE,
} from './pipeline.constants';
import { computeTribeScores, normalizeClaimRisk, TribePillarScores } from './tribe-scoring';

// Frames sampled per video for the visual analysis budget.
const FRAME_SAMPLE_COUNT = 12;

// The 4 fan-out analyzer job types maybeAdvancePastFanout waits on.
const FANOUT_JOB_TYPES = [
  JobType.VISION_ANALYSIS,
  JobType.OCR_ANALYSIS,
  JobType.COLOR_ANALYSIS,
  JobType.SUBJECT_ANALYSIS,
];

// Weights for the composite engagement score.
const ENGAGEMENT_WEIGHTS = {
  hook: 0.35,
  retention: 0.35,
  emotional: 0.15,
  conversion: 0.15,
} as const;

// Short-form platform norms: the duration sweet spot and the point past
// which the format actively fights the video.
const PLATFORM_NORMS = {
  TIKTOK: { idealMaxSec: 30, hardMaxSec: 180 },
  INSTAGRAM_REELS: { idealMaxSec: 30, hardMaxSec: 90 },
  YOUTUBE_SHORTS: { idealMaxSec: 60, hardMaxSec: 60 },
  FACEBOOK_REELS: { idealMaxSec: 30, hardMaxSec: 90 },
  SNAPCHAT: { idealMaxSec: 15, hardMaxSec: 60 },
} as const;

type NormedPlatform = keyof typeof PLATFORM_NORMS;

// The three platforms the comparison/platform-fit UI foregrounds; TikTok and
// Snapchat are still scored (cheap — same inputs) but shown secondarily.
export const PRIMARY_PLATFORMS: NormedPlatform[] = [
  'INSTAGRAM_REELS',
  'YOUTUBE_SHORTS',
  'FACEBOOK_REELS',
];

export interface PlatformFitBreakdown {
  fit: number;
  aspect: number;
  duration: number;
  engagement: number;
}

/**
 * 0–100 fit of this video for one platform, from real attributes:
 * vertical-format fit, duration fit against the platform norm, and how well
 * the measured hook/retention carry a feed context. Returns the blended
 * score plus its three inputs (each 0–100) so callers can explain *why*,
 * not just show a number.
 */
function platformFit(
  platform: NormedPlatform,
  video: {
    durationSec: number | null;
    width: number | null;
    height: number | null;
  },
  signals: { hookScore: number | null; holdRate: number | null },
): PlatformFitBreakdown {
  const norms = PLATFORM_NORMS[platform];

  // Aspect: 9:16 vertical is the native format everywhere in short-form.
  let aspectFit = 0.5;
  if (video.width && video.height) {
    const ratio = video.width / video.height;
    if (ratio <= 0.6)
      aspectFit = 1; // vertical
    else if (ratio <= 1.05)
      aspectFit = 0.6; // square-ish
    else aspectFit = 0.3; // landscape
  }

  let durationFit = 0.5;
  if (video.durationSec != null) {
    if (video.durationSec <= norms.idealMaxSec) durationFit = 1;
    else if (video.durationSec <= norms.hardMaxSec) {
      const over =
        (video.durationSec - norms.idealMaxSec) /
        (norms.hardMaxSec - norms.idealMaxSec);
      durationFit = 1 - 0.6 * over;
    } else durationFit = 0.2;
  }

  const engagementFit =
    ((signals.hookScore ?? 0.5) + (signals.holdRate ?? 0.5)) / 2;

  const fit = 0.3 * aspectFit + 0.3 * durationFit + 0.4 * engagementFit;
  const pct = (v: number) => Math.round(v * 10000) / 100;
  return {
    fit: pct(fit),
    aspect: pct(aspectFit),
    duration: pct(durationFit),
    engagement: pct(engagementFit),
  };
}

/**
 * Human-readable reasons behind one platform's fit score, in the same order
 * as the sub-scores that produced it — the justification the UI shows next
 * to the number.
 */
function explainPlatformFit(
  platform: NormedPlatform,
  breakdown: PlatformFitBreakdown,
  video: {
    durationSec: number | null;
    width: number | null;
    height: number | null;
  },
): string[] {
  const norms = PLATFORM_NORMS[platform];
  const label = platform.replace(/_/g, ' ');
  const reasons: string[] = [];

  if (video.width && video.height) {
    const ratio = video.width / video.height;
    if (ratio <= 0.6)
      reasons.push(`Vertical 9:16 framing — the native format for ${label}.`);
    else if (ratio <= 1.05)
      reasons.push(
        `Square-ish framing is a workable but non-ideal fit for ${label}'s vertical feed.`,
      );
    else
      reasons.push(
        `Landscape framing works against ${label}'s vertical feed — expect letterboxing.`,
      );
  } else {
    reasons.push('Frame dimensions unknown — aspect fit assumed neutral.');
  }

  if (video.durationSec != null) {
    if (video.durationSec <= norms.idealMaxSec) {
      reasons.push(
        `${Math.round(video.durationSec)}s is within ${label}'s ${norms.idealMaxSec}s sweet spot.`,
      );
    } else if (video.durationSec <= norms.hardMaxSec) {
      reasons.push(
        `${Math.round(video.durationSec)}s runs past ${label}'s ${norms.idealMaxSec}s ideal but is still under its ${norms.hardMaxSec}s ceiling.`,
      );
    } else {
      reasons.push(
        `${Math.round(video.durationSec)}s exceeds ${label}'s ${norms.hardMaxSec}s ceiling — trim it for this platform.`,
      );
    }
  } else {
    reasons.push('Duration unknown — duration fit assumed neutral.');
  }

  const engagementLabel =
    breakdown.engagement >= 70
      ? 'strong'
      : breakdown.engagement >= 45
        ? 'moderate'
        : 'weak';
  reasons.push(
    `Predicted hook/hold engagement is ${engagementLabel} (${breakdown.engagement.toFixed(0)}%) for a feed context.`,
  );

  return reasons;
}

export interface RecommendationDraft {
  kind: RecommendationKind;
  title: string;
  body: string;
  rationale: string;
  priority: number;
}

// Same emotionally-charged vocabulary the transcript analyzer scans for
// (apps/ai/app/services/video_analysis/transcript.py EMOTIONAL_KEYWORDS) —
// listed here as UI-facing examples only; this service never imports the
// Python package.
const EMOTIONAL_KEYWORD_EXAMPLES = [
  'amazing',
  'obsessed',
  'game changer',
  'finally',
  'proven',
];

/**
 * Rule-based, numerically-justified content suggestions derived from
 * whatever the pipeline reliably measured for this video — hook, retention,
 * scroll, conversion, and transcript intelligence. Deliberately independent
 * of the TRIBE emotion head's calibration state (see
 * VideoAnalytics.calibrated) so suggestions stay meaningful even before that
 * head has been trained on real outcome data. Every rationale cites the
 * exact number that triggered it, not a generic phrase.
 */
export function buildRecommendations(
  analytics: { hookRate: number | null; holdRate: number | null },
  analysis: AnalysisResult,
  video: { durationSec: number | null },
): RecommendationDraft[] {
  const recs: RecommendationDraft[] = [];

  if (analytics.hookRate != null && analytics.hookRate < 0.5) {
    recs.push({
      kind: RecommendationKind.HOOK,
      title: 'Strengthen the first 3 seconds',
      body: 'Lead with your strongest visual, claim, or motion in the opening frame — viewers decide whether to keep watching almost immediately.',
      rationale: `Predicted hook rate is ${(analytics.hookRate * 100).toFixed(1)}% — below the 50% threshold for viewers surviving the first 3 seconds.`,
      priority: 3,
    });
  }

  const thumbPause = analysis.scroll?.thumb_pause_prob;
  if (thumbPause != null && thumbPause < 0.4) {
    recs.push({
      kind: RecommendationKind.HOOK,
      title: 'Make the opening frame stop the scroll',
      body: 'The first frame alone should be visually arresting — a close-up, bold text, or motion — before any context is given.',
      rationale: `Predicted thumb-pause probability is ${(thumbPause * 100).toFixed(1)}% — below the 40% threshold for interrupting a scrolling feed.`,
      priority: 2,
    });
  }

  const timeline = analysis.retention?.timeline ?? [];
  if (timeline.length > 0) {
    const worst = timeline.reduce(
      (a, b) => (b.drop_prob > a.drop_prob ? b : a),
      timeline[0],
    );
    if (worst.drop_prob > 0.4) {
      recs.push({
        kind: RecommendationKind.SCENE_ORDER,
        title: `Re-cut the ${worst.timestamp.toFixed(1)}s mark`,
        body: 'Drop risk peaks here — add a scene change, cut, or new visual right at this moment to reset viewer attention.',
        rationale: `Predicted drop probability at ${worst.timestamp.toFixed(1)}s is ${(worst.drop_prob * 100).toFixed(1)}%, the highest point in the video.`,
        priority: 2,
      });
    }
  }

  if (analytics.holdRate != null && analytics.holdRate < 0.5) {
    recs.push({
      kind: RecommendationKind.PACING,
      title: 'Tighten pacing to lift hold rate',
      body: 'Cut static stretches, add scene changes or motion every 2–3 seconds, and keep text overlays on screen to carry viewers to the end.',
      rationale: `Predicted hold rate is ${(analytics.holdRate * 100).toFixed(1)}% — below the 50% threshold for short-form retention.`,
      priority: 2,
    });
  }

  if (analysis.transcript?.cta_detected === false) {
    recs.push({
      kind: RecommendationKind.CTA,
      title: 'Add a clear call to action',
      body: 'No call-to-action phrase (e.g. "shop now", "link in bio", "comment below") was found in the script — add one in the closing 20% of the video.',
      rationale: 'No CTA phrase was detected anywhere in the transcript.',
      priority: 2,
    });
  }

  const conversionScore = analysis.conversion?.conversion_score;
  if (conversionScore != null && conversionScore < 0.3) {
    recs.push({
      kind: RecommendationKind.CTA,
      title: 'Sharpen the conversion ask',
      body: 'Make the offer concrete: state the product, the benefit, and the exact next step (e.g. "tap the link to get 20% off") rather than an implied one.',
      rationale: `Predicted conversion score is ${(conversionScore * 100).toFixed(1)}% — below the 30% threshold.`,
      priority: 1,
    });
  }

  const emotionalKeywordCount =
    analysis.transcript?.emotional_keywords?.length ?? 0;
  if (
    emotionalKeywordCount === 0 &&
    (analysis.transcript?.word_count ?? 0) > 0
  ) {
    recs.push({
      kind: RecommendationKind.CAPTIONS,
      title: 'Add emotionally-charged language',
      body: `No emotionally-charged words were detected in the script. Working in a few (e.g. "${EMOTIONAL_KEYWORD_EXAMPLES.join('", "')}") tends to lift engagement in short-form.`,
      rationale: 'Zero emotional keywords detected across the full transcript.',
      priority: 1,
    });
  }

  const wordCount = analysis.transcript?.word_count;
  if (
    wordCount != null &&
    wordCount > 0 &&
    video.durationSec != null &&
    video.durationSec > 0
  ) {
    const density = wordCount / video.durationSec;
    if (density > 4) {
      recs.push({
        kind: RecommendationKind.PACING,
        title: 'Slow the script down',
        body: 'The script reads as dense relative to the video length — viewers may not keep up. Cut lower-value lines or extend the runtime.',
        rationale: `Speech density is ${density.toFixed(1)} words/sec, above the ~4 words/sec comprehension threshold for short-form.`,
        priority: 1,
      });
    } else if (density < 1) {
      recs.push({
        kind: RecommendationKind.PACING,
        title: 'Add more spoken content or motion',
        body: 'The script is sparse relative to the video length, which risks dead air. Add narration, on-screen text, or visual pacing to fill the gaps.',
        rationale: `Speech density is ${density.toFixed(1)} words/sec, below the ~1 word/sec threshold that suggests dead air.`,
        priority: 1,
      });
    }
  }

  return recs;
}

/** A step can finish normally (void/undefined) or degrade gracefully — the
 * step did what it could and the pipeline should keep going, but this
 * specific model's ProcessingJob row should still read as failed rather than
 * silently "completed" with no real output. Only TRIBE_ANALYSIS uses this
 * today: an AI-service outage there shouldn't take down transcript-derived
 * predictions/recommendations that don't need it. */
type StepOutcome = { status: 'degraded'; error: string } | undefined;

@Processor(VIDEO_PIPELINE_QUEUE, { concurrency: 4 })
export class PipelineProcessor extends WorkerHost {
  private readonly logger = new Logger(PipelineProcessor.name);

  private readonly dataDir: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly ai: AiClientService,
    private readonly jobs: JobsService,
    private readonly rules: RulesService,
    config: ConfigService<Env, true>,
  ) {
    super();
    this.dataDir = config.get('CREATIVE_INTELLIGENCE_DATA_DIR', { infer: true });
  }

  async process(job: Job<PipelineJobData>): Promise<void> {
    const { videoId, processingJobId } = job.data;
    await this.jobs.markRunning(processingJobId);

    try {
      let outcome: StepOutcome = undefined;
      switch (job.name) {
        case PipelineStep.PROBE:
          await this.runProbe(videoId);
          break;
        case PipelineStep.FRAME_EXTRACTION:
          await this.runFrameExtraction(videoId);
          break;
        case PipelineStep.TRANSCRIPTION:
          await this.runTranscription(videoId);
          break;
        case PipelineStep.VISION_ANALYSIS:
          outcome = await this.runVisionAnalysis(videoId, processingJobId);
          break;
        case PipelineStep.OCR_ANALYSIS:
          outcome = await this.runOcrAnalysis(videoId, processingJobId);
          break;
        case PipelineStep.COLOR_ANALYSIS:
          outcome = await this.runColorAnalysis(videoId, processingJobId);
          break;
        case PipelineStep.SUBJECT_ANALYSIS:
          outcome = await this.runSubjectAnalysis(videoId, processingJobId);
          break;
        case PipelineStep.TRIBE_ANALYSIS:
          outcome = await this.runTribeAnalysis(videoId);
          break;
        case PipelineStep.SALES_ENGINE:
          outcome = await this.runSalesEngine(videoId);
          break;
        case PipelineStep.PREDICTION:
          await this.runPrediction(videoId);
          break;
        case PipelineStep.RECOMMENDATION:
          await this.runRecommendation(videoId);
          break;
        default:
          throw new Error(`Pipeline step "${job.name}" is not implemented yet`);
      }

      if (outcome?.status === 'degraded') {
        await this.jobs.markFailed(processingJobId, outcome.error);
      } else {
        await this.jobs.markCompleted(processingJobId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Step ${job.name} failed for video ${videoId}: ${message}`,
      );
      await this.jobs.markFailed(processingJobId, message);

      // Only flip the video to FAILED once BullMQ retries are exhausted.
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        const video = await this.prisma.video.update({
          where: { id: videoId },
          data: { status: VideoStatus.FAILED },
        });
        await this.prisma.notification.create({
          data: {
            type: NotificationType.PROCESSING_FAILED,
            title: `Analysis failed: ${video.title}`,
            body: `The ${job.name} step failed: ${message}`,
            link: `/videos/${videoId}`,
            userId: video.uploaderId,
          },
        });
      }
      throw err;
    }
  }

  /**
   * Step 1 (metadata): probe the source through the AI service (ffprobe for
   * VIDEO/AUDIO, PIL dimension read for IMAGE — see apps/ai's filetype.py)
   * and store technical metadata on the video row. Probe failures are
   * non-fatal so the pipeline still progresses in environments where the
   * source is slow to become readable.
   *
   * Branches the next step by media type: VIDEO/IMAGE both need
   * FRAME_EXTRACTION (IMAGE's is a single synthetic frame — see
   * runFrameExtraction); AUDIO has no visual signal and skips straight to
   * TRANSCRIPTION.
   */
  private async runProbe(videoId: string): Promise<void> {
    const video = await this.prisma.video.findUniqueOrThrow({
      where: { id: videoId },
    });

    const sourceUrl = await this.s3.presignDownload(video.storageKey);
    let meta: Awaited<ReturnType<AiClientService['probe']>> | null = null;
    try {
      meta = await this.ai.probe(sourceUrl, video.mediaType);
    } catch (err) {
      this.logger.warn(
        `Probe failed for video ${videoId}, continuing pipeline: ${(err as Error).message}`,
      );
    }

    await this.prisma.video.update({
      where: { id: videoId },
      data: {
        durationSec: meta?.durationSec ?? video.durationSec,
        width: meta?.width ?? video.width,
        height: meta?.height ?? video.height,
        fps: meta?.fps ?? video.fps,
        codec: meta?.codec ?? video.codec ?? 'unknown',
        status: VideoStatus.PROCESSING,
      },
    });

    if (video.mediaType === MediaType.AUDIO) {
      await this.jobs.enqueueStep(PipelineStep.TRANSCRIPTION, videoId);
    } else {
      await this.jobs.enqueueStep(PipelineStep.FRAME_EXTRACTION, videoId);
    }
  }

  /**
   * Step 2 (vision): for VIDEO, the AI service samples frames, uploads
   * JPEGs to the presigned targets, and returns per-frame visual signals,
   * then the pipeline continues to TRANSCRIPTION. For IMAGE, the source
   * *is* the one frame (see ai.extractImageFrame/frames.py's
   * extract_and_upload_image) — no audio track, so the pipeline skips
   * straight to the 4 parallel analyzers instead.
   */
  private async runFrameExtraction(videoId: string): Promise<void> {
    const video = await this.prisma.video.findUniqueOrThrow({
      where: { id: videoId },
    });

    const sourceUrl = await this.s3.presignDownload(video.storageKey);

    if (video.mediaType === MediaType.IMAGE) {
      const key = `${video.storageKey}/frames/0.jpg`;
      const putUrl = await this.s3.presignUpload(key, 'image/jpeg');
      const f = await this.ai.extractImageFrame(sourceUrl, { key, put_url: putUrl });

      await this.prisma.$transaction([
        this.prisma.frame.deleteMany({ where: { videoId } }),
        this.prisma.frame.create({
          data: {
            index: f.index,
            timestampSec: f.timestampSec ?? 0,
            storageKey: f.key,
            isSceneStart: !!f.isSceneStart,
            brightness: f.brightness ?? null,
            dominantColor: f.dominantColor ?? null,
            motionScore: f.motionScore ?? null,
            faceCount: f.faceCount ?? 0,
            hasText: !!f.hasText,
            videoId,
          },
        }),
      ]);

      await this.enqueueAnalyzerFanout(videoId);
      return;
    }

    const uploads: { key: string; put_url: string }[] = [];
    for (let i = 0; i < FRAME_SAMPLE_COUNT; i++) {
      const key = `${video.storageKey}/frames/${i}.jpg`;
      uploads.push({
        key,
        put_url: await this.s3.presignUpload(key, 'image/jpeg'),
      });
    }

    const frames = await this.ai.frames(sourceUrl, uploads);
    if (!frames.length) {
      throw new Error('No frames returned from AI service');
    }

    // Replace-then-insert keeps this step idempotent across BullMQ retries
    // (Frame has a unique constraint on videoId+index).
    await this.prisma.$transaction([
      this.prisma.frame.deleteMany({ where: { videoId } }),
      this.prisma.frame.createMany({
        data: frames.map((f) => ({
          index: f.index,
          timestampSec: f.timestampSec ?? 0,
          storageKey: f.key,
          isSceneStart: !!f.isSceneStart,
          brightness: f.brightness ?? null,
          dominantColor: f.dominantColor ?? null,
          motionScore: f.motionScore ?? null,
          faceCount: f.faceCount ?? 0,
          hasText: !!f.hasText,
          videoId,
        })),
      }),
    ]);

    await this.jobs.enqueueStep(PipelineStep.TRANSCRIPTION, videoId);
  }

  /** Presigned GET URLs for a video's already-extracted frames, in index
   * order — what the 4 parallel analyzers and the Gemini sales engine read
   * instead of the source video/image. */
  private async presignFrameUrls(videoId: string): Promise<string[]> {
    const frames = await this.prisma.frame.findMany({
      where: { videoId },
      orderBy: { index: 'asc' },
    });
    return Promise.all(frames.map((f) => this.s3.presignDownload(f.storageKey)));
  }

  /** Enqueues the 4 parallel analyzers (VIDEO/IMAGE only) — they run
   * concurrently (@Processor concurrency: 4); the last one to finish
   * enqueues TRIBE_ANALYSIS (see maybeAdvancePastFanout). */
  private async enqueueAnalyzerFanout(videoId: string): Promise<void> {
    for (const step of ANALYZER_FANOUT_STEPS) {
      await this.jobs.enqueueStep(step, videoId);
    }
  }

  /** Called by each of the 4 fan-out analyzers after it persists its own
   * result. Counts sibling ProcessingJob rows as COMPLETED — including this
   * job's own row, which is still RUNNING in the DB at this point (process()
   * only calls markCompleted after this method returns) — and enqueues
   * TRIBE_ANALYSIS once all 4 are accounted for. Guards against a
   * double-enqueue if two analyzers finish within the same instant (a real
   * but narrow race under concurrency: 4) by checking no TRIBE_ANALYSIS job
   * already exists for this video before creating one. */
  private async maybeAdvancePastFanout(
    videoId: string,
    processingJobId: string,
  ): Promise<void> {
    // A sibling counts as "done" once it reaches either terminal state —
    // COMPLETED or FAILED (a degraded outcome still returns normally, see
    // process()'s degraded-outcome branch, so BullMQ never retries it; the
    // ProcessingJob row just ends up FAILED). Counting COMPLETED only was a
    // real bug: with 2+ siblings failing, none of their own invocations
    // would see the others as done (each only self-counts via `id`), so
    // the count could never reach 4 and the video stayed stuck in
    // PROCESSING forever. Also includes this job's own id regardless of
    // status, since this method runs before process() writes this job's
    // final COMPLETED/FAILED status.
    const doneCount = await this.prisma.processingJob.count({
      where: {
        videoId,
        type: { in: FANOUT_JOB_TYPES },
        OR: [
          { status: { in: [JobStatus.COMPLETED, JobStatus.FAILED] } },
          { id: processingJobId },
        ],
      },
    });
    if (doneCount < ANALYZER_FANOUT_STEPS.length) return;

    const alreadyEnqueued = await this.prisma.processingJob.findFirst({
      where: { videoId, type: JobType.TRIBE_ANALYSIS },
    });
    if (alreadyEnqueued) return;

    await this.jobs.enqueueStep(PipelineStep.TRIBE_ANALYSIS, videoId);
  }

  /** Parallel analyzer 1 of 4: Gemini Vision scene/object/layout read. */
  private async runVisionAnalysis(
    videoId: string,
    processingJobId: string,
  ): Promise<StepOutcome> {
    let outcome: StepOutcome = undefined;
    try {
      const frameUrls = await this.presignFrameUrls(videoId);
      const scene = await this.ai.analyzeScene(frameUrls);
      await this.prisma.videoAnalytics.upsert({
        where: { videoId },
        create: { videoId, sceneAnalysis: scene as unknown as Prisma.InputJsonValue },
        update: { sceneAnalysis: scene as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Vision analysis failed for video ${videoId}, continuing with an empty scene.json: ${message}`,
      );
      outcome = { status: 'degraded', error: message };
    }
    await this.maybeAdvancePastFanout(videoId, processingJobId);
    return outcome;
  }

  /** Parallel analyzer 2 of 4: OCR module text/CTA/script read. */
  private async runOcrAnalysis(
    videoId: string,
    processingJobId: string,
  ): Promise<StepOutcome> {
    let outcome: StepOutcome = undefined;
    try {
      const frameUrls = await this.presignFrameUrls(videoId);
      const copy = await this.ai.analyzeCopy(frameUrls);
      await this.prisma.videoAnalytics.upsert({
        where: { videoId },
        create: { videoId, copyAnalysis: copy as unknown as Prisma.InputJsonValue },
        update: { copyAnalysis: copy as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `OCR analysis failed for video ${videoId}, continuing with an empty copy.json: ${message}`,
      );
      outcome = { status: 'degraded', error: message };
    }
    await this.maybeAdvancePastFanout(videoId, processingJobId);
    return outcome;
  }

  /** Parallel analyzer 3 of 4: 60/30/10 color analyser. */
  private async runColorAnalysis(
    videoId: string,
    processingJobId: string,
  ): Promise<StepOutcome> {
    let outcome: StepOutcome = undefined;
    try {
      const frameUrls = await this.presignFrameUrls(videoId);
      const colour = await this.ai.analyzeColour(frameUrls);
      await this.prisma.videoAnalytics.upsert({
        where: { videoId },
        create: { videoId, colourAnalysis: colour as unknown as Prisma.InputJsonValue },
        update: { colourAnalysis: colour as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Colour analysis failed for video ${videoId}, continuing with an empty colour.json: ${message}`,
      );
      outcome = { status: 'degraded', error: message };
    }
    await this.maybeAdvancePastFanout(videoId, processingJobId);
    return outcome;
  }

  /** Parallel analyzer 4 of 4: face/subject placement detector. */
  private async runSubjectAnalysis(
    videoId: string,
    processingJobId: string,
  ): Promise<StepOutcome> {
    let outcome: StepOutcome = undefined;
    try {
      const frameUrls = await this.presignFrameUrls(videoId);
      const subject = await this.ai.analyzeSubject(frameUrls);
      await this.prisma.videoAnalytics.upsert({
        where: { videoId },
        create: { videoId, subjectAnalysis: subject as unknown as Prisma.InputJsonValue },
        update: { subjectAnalysis: subject as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Subject analysis failed for video ${videoId}, continuing with an empty subject.json: ${message}`,
      );
      outcome = { status: 'degraded', error: message };
    }
    await this.maybeAdvancePastFanout(videoId, processingJobId);
    return outcome;
  }

  /**
   * Step 3 (speech): Whisper transcription via the AI service. Silent videos
   * produce an empty transcript — a valid outcome, not a failure. Reached by
   * both VIDEO and AUDIO (IMAGE has no audio track and skips this step —
   * see runFrameExtraction). Branches the next step: VIDEO has frames
   * already extracted, so it continues to the 4 parallel analyzers; AUDIO
   * has no visual signal at all and goes straight to TRIBE_ANALYSIS.
   */
  private async runTranscription(videoId: string): Promise<void> {
    const video = await this.prisma.video.findUniqueOrThrow({
      where: { id: videoId },
    });

    const sourceUrl = await this.s3.presignDownload(video.storageKey);
    const result = await this.ai.transcribe(sourceUrl);

    const wordCount = result.full_text
      .split(/\s+/)
      .filter((w) => w.length > 0).length;

    // Camel-cased for storage/serving, matching how the rest of the API
    // presents AI-service output to the frontend (e.g. FrameResult below).
    const audioAnalysis = {
      timeline: result.audio_spikes.timeline.map((p) => ({
        timestampSec: p.timestamp_sec,
        energy: p.energy,
      })),
      spikeCount: result.audio_spikes.spike_count,
      spikeRatePer10s: result.audio_spikes.spike_rate_per_10s,
      avgEnergy: result.audio_spikes.avg_energy,
      spikeScore: result.audio_spikes.spike_score,
    } as unknown as Prisma.InputJsonValue;

    // Replace-then-insert keeps retries and re-analysis idempotent.
    const transcript = await this.prisma.transcript.upsert({
      where: { videoId },
      create: {
        language: result.language,
        fullText: result.full_text,
        wordCount,
        audioAnalysis,
        videoId,
      },
      update: {
        language: result.language,
        fullText: result.full_text,
        wordCount,
        audioAnalysis,
      },
    });

    await this.prisma.$transaction([
      this.prisma.transcriptSegment.deleteMany({
        where: { transcriptId: transcript.id },
      }),
      this.prisma.transcriptSegment.createMany({
        data: result.segments.map((s) => ({
          index: s.index,
          startSec: s.start_sec,
          endSec: s.end_sec,
          text: s.text,
          confidence: s.confidence,
          transcriptId: transcript.id,
        })),
      }),
    ]);

    if (video.mediaType === MediaType.AUDIO) {
      await this.jobs.enqueueStep(PipelineStep.TRIBE_ANALYSIS, videoId);
    } else {
      await this.enqueueAnalyzerFanout(videoId);
    }
  }

  /**
   * Step 4 (Tribe v2 scoring engine): combines the 4 parallel analyzer
   * outputs (see runVisionAnalysis/runOcrAnalysis/runColorAnalysis/
   * runSubjectAnalysis) into pillar scores via computeTribeScores, using
   * live weights from RulesService — the "swappable interface" scoring
   * engine from the approved plan (see tribe-scoring.ts's docstring), not
   * the real vendored TRIBE v2 model.
   *
   * AUDIO media has no visual analyzers to combine, so it keeps using the
   * original transcript-only facade (tribe_v2/client.py) unchanged — that
   * endpoint was built for exactly this case, and AUDIO's score genuinely
   * comes from it. VIDEO/IMAGE never needed that facade's own scoring
   * output (only its bundled transcript-keyword/CTA-phrase extraction,
   * always overridden below by the new pillar-derived scores) but were
   * paying for it anyway — a slow, sometimes-120s-timeout network call to a
   * third-party endpoint, every single run, for a result that got thrown
   * away. VIDEO/IMAGE now calls a local-only transcript-analysis endpoint
   * instead (apps/ai's /v1/videos/analyze/transcript — see
   * ai-client.service.ts's analyzeTranscript), which skips that network hop
   * entirely.
   *
   * The AUDIO facade call is still the one external, third-party-dependent
   * hop in this step — if it fails, that must not take down
   * predictions/recommendations that don't actually need it. On failure
   * this persists neutral defaults and still moves the pipeline forward,
   * returning a `degraded` outcome so only this step's own ProcessingJob
   * row reads as failed.
   */
  private async runTribeAnalysis(videoId: string): Promise<StepOutcome> {
    const [video, frames, transcript, existingAnalytics] = await Promise.all([
      this.prisma.video.findUniqueOrThrow({ where: { id: videoId } }),
      this.prisma.frame.findMany({
        where: { videoId },
        orderBy: { index: 'asc' },
      }),
      this.prisma.transcript.findUnique({
        where: { videoId },
        include: { segments: { orderBy: { index: 'asc' } } },
      }),
      this.prisma.videoAnalytics.findUnique({ where: { videoId } }),
    ]);

    const framesDto: FrameDto[] = frames.map((f) => ({
      key: f.storageKey,
      index: f.index,
      timestamp_sec: f.timestampSec,
      is_scene_start: f.isSceneStart,
      brightness: f.brightness ?? 0,
      dominant_color: f.dominantColor ?? '#000000',
      motion_score: f.motionScore ?? 0,
      face_count: f.faceCount ?? 0,
      has_text: f.hasText,
    }));

    const sourceUrl = await this.s3.presignDownload(video.storageKey);

    // Blended into the same scoring formulas frame motion already feeds
    // (see tribe_v2/client.py's _combined_motion) — undefined/absent JSON
    // shape (e.g. a transcript persisted before this feature existed) just
    // means the AI service falls back to visual motion alone.
    const audioAnalysis = transcript?.audioAnalysis as {
      spikeScore?: number;
    } | null;
    const audioSpikeScore = audioAnalysis?.spikeScore ?? null;

    const transcriptSegmentsDto = (transcript?.segments ?? []).map((s) => ({
      text: s.text,
      start_sec: s.startSec,
      end_sec: s.endSec,
    }));

    const NEUTRAL_ANALYSIS: AnalysisResult = {
      calibrated: false,
      transcript: {
        keywords: [],
        emotional_keywords: [],
        cta_detected: false,
        cta_phrases: [],
        word_count: 0,
      },
      hook: { score: 0.5, issues: [], recommendations: [] },
      sentiment: { emotions: {} },
      retention: {
        timeline: [],
        hook_rate: null,
        hold_rate: null,
        avg_play_time_sec: null,
        duration_sec: null,
      },
      scroll: {
        thumb_pause_prob: null,
        scroll_stop_prob: null,
        first_impression_score: null,
        signals: [],
      },
      conversion: { conversion_score: null, reasons: [] },
      tribe: { segments: {}, signals: [] },
    };

    let analysis: AnalysisResult & { tribe_v2_pillars?: TribePillarScores };
    let outcome: StepOutcome = undefined;

    if (video.mediaType === MediaType.AUDIO) {
      try {
        analysis = await this.ai.analyze({
          source_url: sourceUrl,
          frames: framesDto,
          transcript_text: transcript?.fullText || null,
          transcript_segments: transcriptSegmentsDto,
          audio_spike_score: audioSpikeScore,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `TRIBE analysis failed for video ${videoId}, continuing pipeline with neutral defaults: ${message}`,
        );
        outcome = { status: 'degraded', error: message };
        analysis = NEUTRAL_ANALYSIS;
      }
    } else {
      // Fast path: local transcript intelligence only, no third-party
      // network call — see this method's docstring.
      try {
        const transcriptResult = await this.ai.analyzeTranscript({
          transcript_text: transcript?.fullText || null,
          transcript_segments: transcriptSegmentsDto,
        });
        analysis = { ...NEUTRAL_ANALYSIS, transcript: transcriptResult };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Transcript analysis failed for video ${videoId}, continuing with empty transcript intelligence: ${message}`,
        );
        outcome = { status: 'degraded', error: message };
        analysis = NEUTRAL_ANALYSIS;
      }
    }

    // VIDEO/IMAGE: override the legacy facade's hook/sentiment/retention/
    // scroll/conversion with the new pillar-derived scoring engine — the
    // facade call above still ran (for transcript intelligence only, or as
    // a neutral-default fallback if it errored, which computeTribeScores
    // then supersedes anyway).
    if (video.mediaType !== MediaType.AUDIO) {
      const weights = await this.rules.getWeights();
      const pillars = computeTribeScores({
        weights,
        scene: (existingAnalytics?.sceneAnalysis ?? null) as SceneAnalysis | null,
        copy: (existingAnalytics?.copyAnalysis ?? null) as CopyAnalysis | null,
        colour: (existingAnalytics?.colourAnalysis ?? null) as ColourAnalysis | null,
        subject: (existingAnalytics?.subjectAnalysis ?? null) as SubjectAnalysis | null,
        frameMotionScores: frames
          .map((f) => f.motionScore)
          .filter((v): v is number => v != null),
        video: { width: video.width, height: video.height },
      });

      analysis = {
        ...analysis,
        calibrated: false,
        hook: { score: pillars.subScores.attentionHold, issues: [], recommendations: [] },
        sentiment: {
          emotions: {
            creative_quality: pillars.creativeQuality / 100,
            audience_fit: pillars.audienceFit / 100,
            conversion_safety: pillars.conversionSafety / 100,
            attention_hold: pillars.subScores.attentionHold,
            colour_balance: pillars.subScores.colourBalance,
            typography: pillars.subScores.typography,
            subject_placement: pillars.subScores.subjectPlacement,
          },
        },
        retention: {
          timeline: analysis.retention?.timeline ?? [],
          // The legacy facade always returned null here (tribe_v2/client.py
          // hardcodes it — "no per-timestamp signal from a text-only
          // call"), so this was dead/always-empty for every video
          // regardless of any of today's changes. duration × hold rate is
          // a real, transparent estimate from two values this pipeline
          // actually computes (ffprobe duration, the Tribe v2 hold-rate
          // pillar) rather than a permanently-null legacy field.
          avg_play_time_sec:
            video.durationSec != null
              ? Math.round(video.durationSec * (pillars.creativeQuality / 100) * 100) / 100
              : null,
          duration_sec: video.durationSec,
          hook_rate: pillars.subScores.attentionHold,
          hold_rate: pillars.creativeQuality / 100,
        },
        scroll: {
          thumb_pause_prob: pillars.subScores.attentionHold,
          scroll_stop_prob: pillars.subScores.attentionHold,
          first_impression_score: pillars.subScores.attentionHold,
          signals: [],
        },
        conversion: { conversion_score: pillars.conversionSafety / 100, reasons: [] },
        tribe_v2_pillars: pillars,
      };
    }

    // Persist transcript intelligence next to the transcript itself.
    if (transcript && analysis.transcript) {
      await this.prisma.transcript.update({
        where: { id: transcript.id },
        data: {
          ctaPhrases: (analysis.transcript.cta_phrases ??
            []) as unknown as Prisma.InputJsonValue,
          keywords: {
            keywords: analysis.transcript.keywords ?? [],
            emotional: analysis.transcript.emotional_keywords ?? [],
          },
        },
      });
    }

    const retention: Partial<NonNullable<AnalysisResult['retention']>> =
      analysis.retention ?? {};
    const analyticsData = {
      // Whether the TRIBE head had trained weights loaded for this pass —
      // false means every score below came from a randomly-initialized head
      // and must be presented to the user as preliminary, not measured.
      calibrated: analysis.calibrated ?? false,
      emotionalMap: analysis.sentiment?.emotions ?? {},
      audienceSegments: (analysis.tribe?.segments ??
        {}) as unknown as Prisma.InputJsonValue,
      purchaseIntent: analysis.conversion?.conversion_score ?? null,
      // Probability of scrolling past: prefer the scroll model, fall back
      // to the hook-survival complement for payloads predating it.
      scrollProbability:
        analysis.scroll?.scroll_stop_prob != null
          ? Number((1 - analysis.scroll.scroll_stop_prob).toFixed(4))
          : retention.hook_rate != null
            ? Number((1 - retention.hook_rate).toFixed(4))
            : null,
      attentionCurve: (retention.timeline ??
        []) as unknown as Prisma.InputJsonValue,
      hookRate: retention.hook_rate ?? null,
      holdRate: retention.hold_rate ?? null,
      avgPlayTimeSec: retention.avg_play_time_sec ?? null,
      rawAnalysis: analysis as unknown as Prisma.InputJsonValue,
    };

    await this.prisma.videoAnalytics.upsert({
      where: { videoId },
      create: { ...analyticsData, videoId },
      update: analyticsData,
    });

    await this.jobs.enqueueStep(PipelineStep.SALES_ENGINE, videoId);
    return outcome;
  }

  /**
   * Step 4b (Gemini sales engine): copy corrections, ROAS, claim safety —
   * consumes the copy.json + Tribe v2 pillar scores this step's predecessor
   * just wrote. Assembles VideoAnalytics.unifiedScore (the whiteboard's
   * "unified score JSON") and snapshots it to
   * `${CREATIVE_INTELLIGENCE_DATA_DIR}/video-records/<videoId>.json` +
   * a copy of the hero thumbnail — the diagram's "video record saved
   * [json + thumbnails]" Executive Dashboard box. Failure here is
   * non-fatal: PREDICTION/RECOMMENDATION and the ANALYZED status flip don't
   * depend on the sales engine having run.
   */
  private async runSalesEngine(videoId: string): Promise<StepOutcome> {
    const [video, analytics] = await Promise.all([
      this.prisma.video.findUniqueOrThrow({ where: { id: videoId } }),
      this.prisma.videoAnalytics.findUniqueOrThrow({ where: { videoId } }),
    ]);

    const rawAnalysis = (analytics.rawAnalysis ?? {}) as AnalysisResult & {
      tribe_v2_pillars?: TribePillarScores;
    };
    let pillars = rawAnalysis.tribe_v2_pillars ?? null;
    const copy = (analytics.copyAnalysis ?? {}) as Record<string, unknown>;

    let outcome: StepOutcome = undefined;
    let sales: Awaited<ReturnType<AiClientService['analyzeSales']>> | null = null;
    try {
      const frameUrls = await this.presignFrameUrls(videoId);
      sales = await this.ai.analyzeSales(frameUrls, copy, pillars ?? {});
      await this.prisma.videoAnalytics.update({
        where: { videoId },
        data: { salesEngine: sales as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Sales engine failed for video ${videoId}, continuing without new copy corrections/ROAS: ${message}`,
      );
      outcome = { status: 'degraded', error: message };
      // Fall back to whatever this step wrote last time (e.g. a rescore hit
      // a transient Gemini rate-limit) rather than overwriting previously
      // good ROAS/claim-safety/copy-correction data with nulls — a
      // transient failure on rescore shouldn't destroy a prior success.
      sales = (analytics.salesEngine ?? null) as Awaited<
        ReturnType<AiClientService['analyzeSales']>
      > | null;
    }

    // Fold Gemini's claim-safety read back into the actual score, not just
    // a display field: claimSafety() only affects conversionSafety (never
    // creativeQuality/audienceFit/humanGate — those have no claim-risk
    // input), so this recompute changes conversionSafety/weightedScore/
    // approvalScore/metaAdScore only, using the exact same rule-weighted
    // combine (still respects live rules.json — re-read here since a rule
    // edit between TRIBE_ANALYSIS and now should count too) as the first
    // pass. Without this, a Gemini "High risk" claim-safety read never
    // moved the number a user actually sees — only the local regex did.
    const riskRead = sales?.claim_safety?.risk;
    if (pillars && video.mediaType !== MediaType.AUDIO && riskRead) {
      const frames = await this.prisma.frame.findMany({ where: { videoId } });
      const [weights, existing] = await Promise.all([
        this.rules.getWeights(),
        this.prisma.videoAnalytics.findUnique({ where: { videoId } }),
      ]);
      const finalPillars = computeTribeScores({
        weights,
        scene: (existing?.sceneAnalysis ?? null) as SceneAnalysis | null,
        copy: (existing?.copyAnalysis ?? null) as CopyAnalysis | null,
        colour: (existing?.colourAnalysis ?? null) as ColourAnalysis | null,
        subject: (existing?.subjectAnalysis ?? null) as SubjectAnalysis | null,
        frameMotionScores: frames.map((f) => f.motionScore).filter((v): v is number => v != null),
        video: { width: video.width, height: video.height },
        geminiClaimRisk: riskRead,
      });
      pillars = finalPillars;
      await this.prisma.videoAnalytics.update({
        where: { videoId },
        data: {
          rawAnalysis: {
            ...rawAnalysis,
            tribe_v2_pillars: finalPillars,
            conversion: { conversion_score: finalPillars.conversionSafety / 100, reasons: [] },
            sentiment: {
              emotions: {
                ...(rawAnalysis.sentiment?.emotions ?? {}),
                conversion_safety: finalPillars.conversionSafety / 100,
              },
            },
          } as unknown as Prisma.InputJsonValue,
        },
      });
    }

    const unifiedScore = {
      approvalScore: pillars?.approvalScore ?? null,
      metaAdScore: pillars ? Math.round((pillars.creativeQuality + pillars.conversionSafety) / 2) : null,
      pillars: pillars
        ? {
            creativeQuality: pillars.creativeQuality,
            audienceFit: pillars.audienceFit,
            conversionSafety: pillars.conversionSafety,
          }
        : null,
      humanGate: pillars?.humanGate ?? null,
      roas: sales?.roas ?? null,
      claimSafety: sales?.claim_safety ?? null,
      copyCorrections: sales?.copy_corrections ?? [],
      attentionPeak: pillars?.subScores.attentionHold ?? null,
      nextActions: this.buildNextActions(pillars, sales),
      generatedAt: new Date().toISOString(),
    };

    await this.prisma.videoAnalytics.update({
      where: { videoId },
      data: { unifiedScore: unifiedScore as unknown as Prisma.InputJsonValue },
    });

    await this.writeVideoRecordSnapshot(video, unifiedScore);
    await this.jobs.enqueueStep(PipelineStep.PREDICTION, videoId);
    return outcome;
  }

  /** Short, numbered "what to do next" list for the Approval Desk/Export —
   * cheap rule-based suggestions from the same thresholds the human gate
   * uses, not another AI call. */
  private buildNextActions(
    pillars: TribePillarScores | null,
    sales: Awaited<ReturnType<AiClientService['analyzeSales']>> | null,
  ): string[] {
    if (!pillars) return [];
    const actions: string[] = [];
    if (!pillars.humanGate.passed) {
      actions.push(
        'Human gate failed — simplify the message so the product, promise, and next action read in under a second.',
      );
    }
    if (pillars.subScores.ctaClarity < 0.5) {
      actions.push('Add a clearer, higher-contrast call-to-action.');
    }
    if (pillars.subScores.colourBalance < 0.5) {
      actions.push('Rebalance the palette toward the 60/30/10 base/support/accent split.');
    }
    // sales.claim_safety.risk is free-text from Gemini (see gemini_sales.py
    // — "an overall risk level" is unconstrained wording, not an enum), so
    // real output like "Moderate" never matched a bare === 'medium' check —
    // normalize the same way computeTribeScores' claimSafety() does.
    const normalizedRisk = normalizeClaimRisk(sales?.claim_safety?.risk);
    if (normalizedRisk === 'high' || normalizedRisk === 'medium') {
      actions.push('Review flagged claims for policy risk before scaling spend.');
    }
    return actions.slice(0, 5);
  }

  /** Writes the unified-score snapshot + a copy of the hero thumbnail to
   * CREATIVE_INTELLIGENCE_DATA_DIR/video-records — best-effort, never fails
   * the pipeline (this is a convenience export, not the system of record). */
  private async writeVideoRecordSnapshot(
    video: { id: string; title: string; thumbnailKey: string | null; storageKey: string },
    unifiedScore: Record<string, unknown>,
  ): Promise<void> {
    try {
      const recordsDir = path.join(this.dataDir, 'video-records');
      await fs.mkdir(recordsDir, { recursive: true });
      await fs.writeFile(
        path.join(recordsDir, `${video.id}.json`),
        JSON.stringify({ videoId: video.id, title: video.title, ...unifiedScore }, null, 2),
        'utf-8',
      );

      const thumbnailKey = video.thumbnailKey ?? `${video.storageKey}/frames/0.jpg`;
      try {
        const url = await this.s3.presignDownload(thumbnailKey);
        const res = await fetch(url);
        if (res.ok) {
          const buffer = Buffer.from(await res.arrayBuffer());
          await fs.writeFile(path.join(recordsDir, `${video.id}.jpg`), buffer);
        }
      } catch {
        // Thumbnail is a nice-to-have on this snapshot — the JSON record
        // above is what matters and is already written.
      }
    } catch (err) {
      this.logger.warn(
        `Could not write video-record snapshot for video ${video.id}: ${(err as Error).message}`,
      );
    }
  }

  /** Step 5: derive normalized 0–100 scores from the stored analysis. */
  private async runPrediction(videoId: string): Promise<void> {
    const [analytics, video] = await Promise.all([
      this.prisma.videoAnalytics.findUniqueOrThrow({ where: { videoId } }),
      this.prisma.video.findUniqueOrThrow({ where: { id: videoId } }),
    ]);
    const analysis = (analytics.rawAnalysis ?? {}) as AnalysisResult;

    const clamp = (v: number) =>
      Math.max(0, Math.min(100, Math.round(v * 100) / 100));
    const preds: {
      kind: PredictionKind;
      score: number;
      breakdown?: Record<string, unknown>;
    }[] = [];

    const hookScore = analysis.hook?.score;
    if (hookScore != null) {
      preds.push({ kind: PredictionKind.HOOK, score: clamp(hookScore * 100) });
    }

    const holdRate = analytics.holdRate;
    if (holdRate != null) {
      preds.push({
        kind: PredictionKind.RETENTION,
        score: clamp(holdRate * 100),
      });
    }

    const emotions = analysis.sentiment?.emotions;
    if (emotions && Object.keys(emotions).length > 0) {
      const peak = Math.max(
        ...Object.values(emotions).map((v) => Number(v) || 0),
      );
      preds.push({
        kind: PredictionKind.EMOTIONAL_IMPACT,
        score: clamp(peak * 100),
      });
    }

    const conversionScore = analysis.conversion?.conversion_score;
    if (conversionScore != null) {
      preds.push({
        kind: PredictionKind.CONVERSION,
        score: clamp(conversionScore * 100),
      });
    }

    if (preds.length > 0) {
      const byKind = Object.fromEntries(preds.map((p) => [p.kind, p.score]));
      const engagement =
        ENGAGEMENT_WEIGHTS.hook * (byKind[PredictionKind.HOOK] ?? 50) +
        ENGAGEMENT_WEIGHTS.retention *
          (byKind[PredictionKind.RETENTION] ?? 50) +
        ENGAGEMENT_WEIGHTS.emotional *
          (byKind[PredictionKind.EMOTIONAL_IMPACT] ?? 50) +
        ENGAGEMENT_WEIGHTS.conversion *
          (byKind[PredictionKind.CONVERSION] ?? 50);
      preds.push({ kind: PredictionKind.ENGAGEMENT, score: clamp(engagement) });
    }

    // Platform compatibility: fit + justification per short-form platform,
    // headline score is the fit for the video's own target platform.
    if (preds.length > 0) {
      const signals = {
        hookScore: analysis.hook?.score ?? null,
        holdRate: analytics.holdRate,
      };
      const breakdown = Object.fromEntries(
        (Object.keys(PLATFORM_NORMS) as NormedPlatform[]).map((platform) => {
          const fitBreakdown = platformFit(platform, video, signals);
          return [
            platform,
            {
              ...fitBreakdown,
              reasons: explainPlatformFit(platform, fitBreakdown, video),
            },
          ];
        }),
      );
      const target = video.targetPlatform as NormedPlatform;
      const targetFit = breakdown[target]?.fit;
      const bestFit = Math.max(...Object.values(breakdown).map((b) => b.fit));
      preds.push({
        kind: PredictionKind.PLATFORM_COMPATIBILITY,
        score: clamp(targetFit ?? bestFit),
        breakdown: breakdown,
      });
    }

    // Replace-then-insert: re-analysis and retries never duplicate scores.
    await this.prisma.$transaction([
      this.prisma.prediction.deleteMany({ where: { videoId } }),
      this.prisma.prediction.createMany({
        data: preds.map((p) => ({
          kind: p.kind,
          score: p.score,
          confidence: 0.5,
          breakdown: (p.breakdown ?? {}) as unknown as Prisma.InputJsonValue,
          modelName: 'tribe-v2-mvp',
          videoId,
        })),
      }),
    ]);

    await this.jobs.enqueueStep(PipelineStep.RECOMMENDATION, videoId);
  }

  /** Step 6: turn analysis findings into actionable, justified recommendations. */
  private async runRecommendation(videoId: string): Promise<void> {
    const [analytics, video] = await Promise.all([
      this.prisma.videoAnalytics.findUniqueOrThrow({ where: { videoId } }),
      this.prisma.video.findUniqueOrThrow({ where: { id: videoId } }),
    ]);
    const analysis = (analytics.rawAnalysis ?? {}) as AnalysisResult;

    const recs = buildRecommendations(analytics, analysis, video);

    await this.prisma.$transaction([
      this.prisma.recommendation.deleteMany({ where: { videoId } }),
      this.prisma.recommendation.createMany({
        data: recs.map((r) => ({ ...r, videoId })),
      }),
    ]);

    const analyzedVideo = await this.prisma.video.update({
      where: { id: videoId },
      data: { status: VideoStatus.ANALYZED },
    });

    // Notify the uploader and count the analysis against the team quota.
    await Promise.all([
      this.prisma.notification.create({
        data: {
          type: NotificationType.PROCESSING_COMPLETE,
          title: `Analysis complete: ${analyzedVideo.title}`,
          body:
            recs.length > 0
              ? `The pipeline finished with ${recs.length} recommendation${recs.length === 1 ? '' : 's'}.`
              : 'The pipeline finished. Scores and modules are ready.',
          link: `/videos/${videoId}`,
          userId: analyzedVideo.uploaderId,
        },
      }),
      recs.length > 0
        ? this.prisma.notification.create({
            data: {
              type: NotificationType.RECOMMENDATION_READY,
              title: `Suggestions ready: ${analyzedVideo.title}`,
              body: recs
                .slice(0, 2)
                .map((r) => r.title)
                .join(' · '),
              link: `/videos/${videoId}?tab=suggestions`,
              userId: analyzedVideo.uploaderId,
            },
          })
        : Promise.resolve(null),
      this.prisma.subscription.upsert({
        where: { teamId: analyzedVideo.teamId },
        create: { teamId: analyzedVideo.teamId, videosUsed: 1 },
        update: { videosUsed: { increment: 1 } },
      }),
    ]);
  }
}
