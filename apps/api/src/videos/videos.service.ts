import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { JobType, MediaType, Prisma, VideoStatus } from '@vip/database';
import { randomUUID } from 'node:crypto';
import { AuthenticatedUser } from '../auth/auth.types';
import type { AnalysisResult } from '../jobs/ai-client.service';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../storage/s3.service';
import { AssignVariantDto } from './dto/assign-variant.dto';
import { CreateUploadDto } from './dto/create-upload.dto';
import { ListVideosDto } from './dto/list-videos.dto';
import { RecordApprovalDto } from './dto/record-approval.dto';
import { RecordOutcomeDto } from './dto/record-outcome.dto';

// S3 key prefix per media type — keeps video/image/audio sources visibly
// separated within the shared S3_BUCKET_VIDEOS bucket rather than needing a
// new bucket/env var per type.
const STORAGE_PREFIX: Record<MediaType, string> = {
  [MediaType.VIDEO]: 'videos',
  [MediaType.IMAGE]: 'images',
  [MediaType.AUDIO]: 'audio',
};

// Metrics the reference "cognitive analysis" spec asked for that our TRIBE v2
// integration genuinely cannot produce — a text-only call to a third-party
// endpoint (see apps/ai/app/services/tribe_v2/client.py) with no per-scene,
// per-timestamp, or cross-modal signal. Listed explicitly in the API response
// so the UI can say so, rather than silently omitting or inventing them.
const TRIBE_UNSUPPORTED_METRICS = [
  'Information processing',
  'Semantic understanding',
  'Memory encoding potential',
  'Cognitive load',
  'Temporal attention changes (no per-timestamp signal)',
  'Scene-level cognitive response (no scene boundaries in a text-only call)',
  'Cross-modal consistency (only the transcript is scored, not audio/video)',
] as const;

export interface TribeAnalysisDto {
  calibrated: boolean;
  processingTimeMs: number | null;
  cognitive: {
    attentionCapture: number | null;
    emotionalValence: number | null;
    neuralResponse: number | null;
    visualSaliency: number | null;
  };
  derived: {
    hookScore: number | null;
    scrollStopProbability: number | null;
    conversionScore: number | null;
  };
  unsupportedMetrics: readonly string[];
}

@Injectable()
export class VideosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly jobs: JobsService,
  ) {}

  /**
   * Step 1 of the pipeline: register the video and hand the browser a
   * presigned URL so the file streams directly to object storage without
   * passing through the API.
   */
  async createUpload(user: AuthenticatedUser, dto: CreateUploadDto) {
    const mediaType = dto.mediaType ?? MediaType.VIDEO;
    const extension = dto.filename.includes('.')
      ? dto.filename.slice(dto.filename.lastIndexOf('.'))
      : '';
    const storageKey = `${user.teamId}/${STORAGE_PREFIX[mediaType]}/${randomUUID()}${extension}`;

    // A variant group is scoped to the team, same as the video itself —
    // reject an id from another team rather than silently dropping it.
    if (dto.variantGroupId) {
      const group = await this.prisma.variantGroup.findFirst({
        where: { id: dto.variantGroupId, teamId: user.teamId },
      });
      if (!group) throw new NotFoundException('Variant group not found');
    }

    const video = await this.prisma.video.create({
      data: {
        title: dto.title,
        description: dto.description,
        status: VideoStatus.UPLOADING,
        targetPlatform: dto.targetPlatform,
        mediaType,
        storageKey,
        originalFilename: dto.filename,
        mimeType: dto.mimeType,
        sizeBytes: BigInt(dto.sizeBytes),
        teamId: user.teamId,
        uploaderId: user.id,
        variantGroupId: dto.variantGroupId,
        variantLabel: dto.variantLabel,
      },
    });

    const uploadUrl = await this.s3.presignUpload(storageKey, dto.mimeType);
    return { video, uploadUrl };
  }

  /** Called by the client after the PUT succeeds; kicks off processing. */
  async completeUpload(user: AuthenticatedUser, videoId: string) {
    const video = await this.getOwned(user, videoId);

    const updated = await this.prisma.video.update({
      where: { id: video.id },
      data: { status: VideoStatus.UPLOADED },
    });

    // Give a small grace window to allow the browser PUT to fully commit
    // in object storage before ffprobe attempts to read the presigned URL.
    await this.jobs.enqueueProbe(updated.id, 2000);
    return updated;
  }

  /** Re-run the full analysis pipeline over an already-uploaded video. */
  async reanalyze(user: AuthenticatedUser, videoId: string) {
    const video = await this.getOwned(user, videoId);
    if (video.status === VideoStatus.UPLOADING) {
      throw new BadRequestException('Upload has not completed yet');
    }

    // Every other pipeline artifact (frames, predictions, recommendations)
    // is wiped and recreated on each run — ProcessingJob wasn't, so the
    // pipeline history view kept accumulating every past attempt's steps
    // forever instead of showing just the current run.
    await this.prisma.processingJob.deleteMany({
      where: { videoId: video.id },
    });

    const updated = await this.prisma.video.update({
      where: { id: video.id },
      data: { status: VideoStatus.PROCESSING },
    });
    await this.jobs.enqueueProbe(updated.id);
    return updated;
  }

  async list(user: AuthenticatedUser, query: ListVideosDto) {
    const where: Prisma.VideoWhereInput = {
      teamId: user.teamId,
      ...(query.status && { status: query.status }),
      ...(query.platform && { targetPlatform: query.platform }),
      ...(query.approvalStatus && { approvalStatus: query.approvalStatus }),
      ...(query.search && {
        // Re-added on the 2026-09-11 Postgres migration — MySQL's default
        // utf8mb4 collation was case-insensitive for free, so this was
        // dropped when the app moved off Postgres the first time
        // (`mode: 'insensitive'` is a Postgres-only Prisma filter and
        // errors against MySQL). Now that the datasource is Postgres again,
        // omitting it would silently make title search case-sensitive.
        title: { contains: query.search, mode: 'insensitive' },
      }),
    };

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.video.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          jobs: { orderBy: { createdAt: 'desc' }, take: 1 },
          _count: { select: { recommendations: true } },
        },
      }),
      this.prisma.video.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /** Move a video into (or out of) a variant group, and/or relabel it. */
  async assignVariant(
    user: AuthenticatedUser,
    videoId: string,
    dto: AssignVariantDto,
  ) {
    await this.getOwned(user, videoId);

    if (dto.variantGroupId) {
      const group = await this.prisma.variantGroup.findFirst({
        where: { id: dto.variantGroupId, teamId: user.teamId },
      });
      if (!group) throw new NotFoundException('Variant group not found');
    }

    return this.prisma.video.update({
      where: { id: videoId },
      data: {
        ...(dto.variantGroupId !== undefined && {
          variantGroupId: dto.variantGroupId,
        }),
        ...(dto.variantLabel !== undefined && {
          variantLabel: dto.variantLabel,
        }),
      },
    });
  }

  /** Records (or updates) real, ground-truth performance for a published
   * video — the label data apps/ai/scripts/train_tribe_head.py needs.
   * Never predicted; only ever what the caller actually observed. */
  async recordOutcome(
    user: AuthenticatedUser,
    videoId: string,
    dto: RecordOutcomeDto,
  ) {
    await this.getOwned(user, videoId);
    return this.prisma.videoOutcome.upsert({
      where: { videoId },
      create: {
        videoId,
        hookRate: dto.hookRate,
        holdRate: dto.holdRate,
        conversionScore: dto.conversionScore,
        source: dto.source,
        notes: dto.notes,
      },
      update: {
        hookRate: dto.hookRate,
        holdRate: dto.holdRate,
        conversionScore: dto.conversionScore,
        source: dto.source,
        notes: dto.notes,
      },
    });
  }

  /** Approval Desk reviewer decision — separate from `status` (pipeline
   * progress). Moving a video out of PENDING is what the Creative Queue
   * (the /videos list, filtered by approvalStatus) treats as "reviewed". */
  async recordApproval(
    user: AuthenticatedUser,
    videoId: string,
    dto: RecordApprovalDto,
  ) {
    await this.getOwned(user, videoId);
    return this.prisma.video.update({
      where: { id: videoId },
      data: {
        approvalStatus: dto.status,
        approvalNotes: dto.notes,
        approvedAt: new Date(),
        approvedById: user.id,
      },
    });
  }

  async getById(user: AuthenticatedUser, videoId: string) {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, teamId: user.teamId },
      include: {
        jobs: { orderBy: { createdAt: 'asc' } },
        transcript: { include: { segments: { orderBy: { index: 'asc' } } } },
        analytics: true,
        predictions: true,
        recommendations: { orderBy: { priority: 'desc' } },
        variantGroup: true,
        outcome: true,
      },
    });
    if (!video) throw new NotFoundException('Video not found');

    const playbackUrl =
      video.status !== VideoStatus.UPLOADING
        ? await this.s3.presignDownload(video.storageKey)
        : null;

    return {
      ...video,
      playbackUrl,
      tribeAnalysis: this.buildTribeAnalysis(video.analytics, video.jobs),
    };
  }

  /** Derives the TRIBE v2 report-section DTO from already-stored data — no
   * separate storage, just a read-side reshape of VideoAnalytics.rawAnalysis
   * plus the TRIBE_ANALYSIS ProcessingJob's timing. */
  private buildTribeAnalysis(
    analytics: { calibrated: boolean; rawAnalysis: Prisma.JsonValue } | null,
    jobs: { type: JobType; startedAt: Date | null; completedAt: Date | null }[],
  ): TribeAnalysisDto | null {
    if (!analytics) return null;

    const analysis = (analytics.rawAnalysis ?? {}) as AnalysisResult;
    const tribeJob = [...jobs]
      .reverse()
      .find((j) => j.type === JobType.TRIBE_ANALYSIS && j.completedAt);
    const processingTimeMs =
      tribeJob?.startedAt && tribeJob.completedAt
        ? tribeJob.completedAt.getTime() - tribeJob.startedAt.getTime()
        : null;

    const emotions = analysis.sentiment?.emotions ?? {};

    return {
      calibrated: analytics.calibrated,
      processingTimeMs,
      cognitive: {
        attentionCapture: emotions.attention_capture ?? null,
        emotionalValence: emotions.emotional_valence ?? null,
        neuralResponse: emotions.overall_brain_engagement ?? null,
        visualSaliency: emotions.visual_imagery ?? null,
      },
      derived: {
        hookScore: analysis.hook?.score ?? null,
        scrollStopProbability: analysis.scroll?.scroll_stop_prob ?? null,
        conversionScore: analysis.conversion?.conversion_score ?? null,
      },
      unsupportedMetrics: TRIBE_UNSUPPORTED_METRICS,
    };
  }

  async remove(user: AuthenticatedUser, videoId: string) {
    const video = await this.getOwned(user, videoId);
    await this.prisma.video.delete({ where: { id: video.id } });
    // Storage cleanup after the DB row is gone; a failed delete here leaves
    // an orphaned object, which is acceptable and cleanable by lifecycle rules.
    await this.s3.deleteObject(video.storageKey).catch(() => undefined);
    return { deleted: true };
  }

  private async getOwned(user: AuthenticatedUser, videoId: string) {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, teamId: user.teamId },
    });
    if (!video) throw new NotFoundException('Video not found');
    return video;
  }
}
