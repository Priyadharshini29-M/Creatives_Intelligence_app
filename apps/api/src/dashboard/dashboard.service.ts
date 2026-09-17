import { Injectable } from '@nestjs/common';
import {
  ApprovalStatus,
  JobStatus,
  Prisma,
  PredictionKind,
  VideoStatus,
} from '@vip/database';
import { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

// The four raw dimensions TRIBE v2's text-scoring call actually produces
// (see apps/ai/app/services/tribe_v2/client.py) — stored per-video in
// VideoAnalytics.emotionalMap. Averaged here in application code rather than
// via Prisma's groupBy/_avg (which only works on real columns, not JSON
// keys) since MySQL JSON aggregation isn't worth the raw-SQL complexity at
// this data scale.
const TRIBE_COGNITIVE_KEYS = [
  'attention_capture',
  'emotional_valence',
  'overall_brain_engagement',
  'visual_imagery',
] as const;

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  /** Executive dashboard headline metrics, computed from real team data. */
  async summary(user: AuthenticatedUser) {
    const teamId = user.teamId;

    const [
      videoCounts,
      approvalCounts,
      activeJobs,
      recentVideos,
      scoreAverages,
      tribeAnalytics,
      unifiedScores,
      openRecommendations,
    ] = await Promise.all([
      this.prisma.video.groupBy({
        by: ['status'],
        where: { teamId },
        orderBy: { status: 'asc' },
        _count: { _all: true },
      }),
      this.prisma.video.groupBy({
        by: ['approvalStatus'],
        where: { teamId },
        orderBy: { approvalStatus: 'asc' },
        _count: { _all: true },
      }),
      this.prisma.processingJob.count({
        where: {
          video: { teamId },
          status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] },
        },
      }),
      this.prisma.video.findMany({
        where: { teamId },
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: {
          predictions: { where: { kind: PredictionKind.ENGAGEMENT }, take: 1 },
          jobs: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      }),
      this.prisma.prediction.groupBy({
        by: ['kind'],
        where: { video: { teamId } },
        orderBy: { kind: 'asc' },
        _avg: { score: true },
      }),
      this.prisma.videoAnalytics.findMany({
        where: { video: { teamId, status: VideoStatus.ANALYZED } },
        select: { emotionalMap: true, calibrated: true },
      }),
      this.prisma.videoAnalytics.findMany({
        where: {
          video: { teamId, status: VideoStatus.ANALYZED },
          unifiedScore: { not: Prisma.JsonNull },
        },
        select: { unifiedScore: true },
      }),
      // Recommendation.title comes from a fixed set of rule-based templates
      // (buildRecommendations() below — same trigger condition always
      // produces the same title text), so grouping by title across the
      // whole team's videos is a real "how many creatives share this same
      // issue" count, not an approximation.
      this.prisma.recommendation.findMany({
        where: {
          applied: false,
          video: { teamId, status: VideoStatus.ANALYZED },
        },
        orderBy: { priority: 'desc' },
        select: {
          title: true,
          body: true,
          rationale: true,
          priority: true,
          videoId: true,
        },
      }),
    ]);

    const countsByStatus = Object.fromEntries(
      videoCounts.map((c) => [c.status, c._count._all]),
    ) as Partial<Record<VideoStatus, number>>;

    const approvalStatusCounts = Object.fromEntries(
      approvalCounts.map((c) => [c.approvalStatus, c._count._all]),
    ) as Partial<Record<ApprovalStatus, number>>;

    const avgScores = Object.fromEntries(
      scoreAverages.map((s) => [s.kind, s._avg?.score ?? null]),
    ) as Partial<Record<PredictionKind, number | null>>;

    return {
      totals: {
        videos: videoCounts.reduce((sum, c) => sum + c._count._all, 0),
        analyzed: countsByStatus[VideoStatus.ANALYZED] ?? 0,
        processing: countsByStatus[VideoStatus.PROCESSING] ?? 0,
        failed: countsByStatus[VideoStatus.FAILED] ?? 0,
        activeJobs,
      },
      avgScores,
      recentVideos,
      approvalStatusCounts,
      // Legacy AUDIO-only tile — see averageTribeCognitive's docstring for
      // why VIDEO/IMAGE no longer populate this since the Milestone 4
      // scoring engine change.
      tribeIntelligence: this.averageTribeCognitive(tribeAnalytics),
      // The new Tribe v2 scoring engine's pillar averages (VIDEO/IMAGE) —
      // the whiteboard's "Tribe v2" dashboard tile.
      tribeV2: this.averageUnifiedScores(unifiedScores),
      // Cross-video recommendation rollup for the Executive Overview's "Key
      // Recommendations" panel — real per-video Recommendation rows
      // (buildRecommendations() in pipeline.processor.ts), grouped by their
      // shared title so a systemic issue (e.g. "Add a clear call to
      // action" on 19 videos) surfaces once with an honest affected-video
      // count, not fabricated "impact %" figures nothing in this pipeline
      // actually measures.
      keyRecommendations: this.aggregateRecommendations(openRecommendations),
    };
  }

  /** Groups open (not-yet-applied) Recommendation rows by their title —
   * stable across videos since buildRecommendations() always emits the same
   * title for the same trigger condition — keeping the highest priority and
   * one representative video per group (for the "Review" deep link), sorted
   * by priority then by how many videos share the issue. */
  private aggregateRecommendations(
    rows: {
      title: string;
      body: string;
      rationale: string | null;
      priority: number;
      videoId: string;
    }[],
  ) {
    const byTitle = new Map<
      string,
      {
        title: string;
        body: string;
        rationale: string | null;
        priority: number;
        videoIds: Set<string>;
      }
    >();
    for (const row of rows) {
      const existing = byTitle.get(row.title);
      if (existing) {
        existing.videoIds.add(row.videoId);
        existing.priority = Math.max(existing.priority, row.priority);
      } else {
        byTitle.set(row.title, {
          title: row.title,
          body: row.body,
          rationale: row.rationale,
          priority: row.priority,
          videoIds: new Set([row.videoId]),
        });
      }
    }
    return [...byTitle.values()]
      .map((g) => ({
        title: g.title,
        body: g.body,
        rationale: g.rationale,
        priority: g.priority,
        videoCount: g.videoIds.size,
        sampleVideoId: [...g.videoIds][0],
      }))
      .sort((a, b) => b.priority - a.priority || b.videoCount - a.videoCount)
      .slice(0, 5);
  }

  /** Averages the Tribe v2 scoring engine's pillar scores (unifiedScore —
   * see pipeline.processor.ts's runSalesEngine) across analyzed VIDEO/IMAGE
   * videos. AUDIO media never gets a unifiedScore (its scoring path is the
   * legacy transcript-only facade, not the pillar engine), so it's simply
   * absent from this average rather than skewing it with nulls. */
  private averageUnifiedScores(rows: { unifiedScore: Prisma.JsonValue }[]) {
    let approvalSum = 0;
    let creativeQualitySum = 0;
    let audienceFitSum = 0;
    let conversionSafetySum = 0;
    let counted = 0;

    for (const row of rows) {
      const score = row.unifiedScore as {
        approvalScore?: number | null;
        pillars?: {
          creativeQuality?: number | null;
          audienceFit?: number | null;
          conversionSafety?: number | null;
        } | null;
      } | null;
      if (!score?.pillars) continue;
      approvalSum += score.approvalScore ?? 0;
      creativeQualitySum += score.pillars.creativeQuality ?? 0;
      audienceFitSum += score.pillars.audienceFit ?? 0;
      conversionSafetySum += score.pillars.conversionSafety ?? 0;
      counted += 1;
    }

    if (counted === 0) {
      return {
        avgApprovalScore: null,
        avgCreativeQuality: null,
        avgAudienceFit: null,
        avgConversionSafety: null,
        sampleSize: 0,
      };
    }

    return {
      avgApprovalScore: Math.round((approvalSum / counted) * 100) / 100,
      avgCreativeQuality:
        Math.round((creativeQualitySum / counted) * 100) / 100,
      avgAudienceFit: Math.round((audienceFitSum / counted) * 100) / 100,
      avgConversionSafety:
        Math.round((conversionSafetySum / counted) * 100) / 100,
      sampleSize: counted,
    };
  }

  /** Averages the four legacy TRIBE v2 text-facade cognitive dimensions
   * across analyzed videos that actually have them. Since the Milestone 4
   * scoring-engine change, only AUDIO media still populates these specific
   * keys (VIDEO/IMAGE's emotionalMap uses the new pillar-score keys
   * instead — see averageUnifiedScores for those). Rows without the legacy
   * keys are simply skipped rather than counted as zero. */
  private averageTribeCognitive(
    rows: { emotionalMap: Prisma.JsonValue; calibrated: boolean }[],
  ) {
    const sums: Record<(typeof TRIBE_COGNITIVE_KEYS)[number], number> = {
      attention_capture: 0,
      emotional_valence: 0,
      overall_brain_engagement: 0,
      visual_imagery: 0,
    };
    let counted = 0;

    for (const row of rows) {
      const map = row.emotionalMap as Record<string, number> | null;
      if (!map || !(TRIBE_COGNITIVE_KEYS[0] in map)) continue;
      for (const key of TRIBE_COGNITIVE_KEYS) sums[key] += map[key] ?? 0;
      counted += 1;
    }

    if (counted === 0) {
      return {
        avgAttention: null,
        avgEmotionalValence: null,
        avgNeuralResponse: null,
        avgVisualSaliency: null,
        calibratedShare: null,
        sampleSize: 0,
      };
    }

    return {
      avgAttention: sums.attention_capture / counted,
      avgEmotionalValence: sums.emotional_valence / counted,
      avgNeuralResponse: sums.overall_brain_engagement / counted,
      avgVisualSaliency: sums.visual_imagery / counted,
      calibratedShare: rows.filter((r) => r.calibrated).length / rows.length,
      sampleSize: counted,
    };
  }
}
