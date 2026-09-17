import { Injectable } from '@nestjs/common';
import { PredictionKind, VideoStatus } from '@vip/database';
import { AuthenticatedUser } from '../auth/auth.types';
import { AnalysisResult } from '../jobs/ai-client.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class InsightsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Tribe audience affinities per analyzed video, plus the team aggregate. */
  async tribe(user: AuthenticatedUser) {
    const videos = await this.prisma.video.findMany({
      where: { teamId: user.teamId, status: VideoStatus.ANALYZED },
      orderBy: { createdAt: 'desc' },
      include: { analytics: true },
    });

    const perVideo = videos.map((video) => {
      const analysis = (video.analytics?.rawAnalysis ?? {}) as AnalysisResult;
      return {
        id: video.id,
        title: video.title,
        targetPlatform: video.targetPlatform,
        segments: (video.analytics?.audienceSegments ?? {}) as Record<
          string,
          number
        >,
        signals: analysis.tribe?.signals ?? [],
      };
    });

    // Team aggregate: mean affinity per segment across analyzed videos.
    const sums: Record<string, { total: number; n: number }> = {};
    for (const video of perVideo) {
      for (const [segment, affinity] of Object.entries(video.segments)) {
        sums[segment] ??= { total: 0, n: 0 };
        sums[segment].total += Number(affinity) || 0;
        sums[segment].n += 1;
      }
    }
    const aggregate = Object.fromEntries(
      Object.entries(sums).map(([segment, { total, n }]) => [
        segment,
        Math.round((total / n) * 10000) / 10000,
      ]),
    );

    return { videos: perVideo, aggregate };
  }

  /** Per-platform compatibility for every analyzed video + team averages. */
  async platforms(user: AuthenticatedUser) {
    const predictions = await this.prisma.prediction.findMany({
      where: {
        kind: PredictionKind.PLATFORM_COMPATIBILITY,
        video: { teamId: user.teamId },
      },
      include: { video: { select: { id: true, title: true, targetPlatform: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const perVideo = predictions.map((prediction) => ({
      id: prediction.video.id,
      title: prediction.video.title,
      targetPlatform: prediction.video.targetPlatform,
      score: prediction.score,
      breakdown: (prediction.breakdown ?? {}) as Record<string, number>,
    }));

    const sums: Record<string, { total: number; n: number }> = {};
    for (const video of perVideo) {
      for (const [platform, score] of Object.entries(video.breakdown)) {
        sums[platform] ??= { total: 0, n: 0 };
        sums[platform].total += Number(score) || 0;
        sums[platform].n += 1;
      }
    }
    const aggregate = Object.fromEntries(
      Object.entries(sums).map(([platform, { total, n }]) => [
        platform,
        Math.round((total / n) * 100) / 100,
      ]),
    );

    return { videos: perVideo, aggregate };
  }

  /**
   * Internal benchmarks: each analyzed video's scores against the team
   * average. External competitor tracking needs a data source integration —
   * until then this is deliberately scoped to the team's own library.
   */
  async benchmarks(user: AuthenticatedUser) {
    const videos = await this.prisma.video.findMany({
      where: { teamId: user.teamId, status: VideoStatus.ANALYZED },
      orderBy: { createdAt: 'desc' },
      include: { predictions: true, analytics: true },
    });

    const kinds = [
      PredictionKind.ENGAGEMENT,
      PredictionKind.HOOK,
      PredictionKind.RETENTION,
      PredictionKind.EMOTIONAL_IMPACT,
      PredictionKind.CONVERSION,
    ];

    const perVideo = videos.map((video) => {
      const scores = Object.fromEntries(
        kinds.map((kind) => [
          kind,
          video.predictions.find((p) => p.kind === kind)?.score ?? null,
        ]),
      ) as Record<string, number | null>;
      return {
        id: video.id,
        title: video.title,
        createdAt: video.createdAt,
        targetPlatform: video.targetPlatform,
        scores,
        hookRate: video.analytics?.hookRate ?? null,
        holdRate: video.analytics?.holdRate ?? null,
      };
    });

    const averages = Object.fromEntries(
      kinds.map((kind) => {
        const values = perVideo
          .map((v) => v.scores[kind])
          .filter((s): s is number => s != null);
        return [
          kind,
          values.length > 0
            ? Math.round(
                (values.reduce((a, b) => a + b, 0) / values.length) * 100,
              ) / 100
            : null,
        ];
      }),
    ) as Record<string, number | null>;

    return { videos: perVideo, averages };
  }
}
