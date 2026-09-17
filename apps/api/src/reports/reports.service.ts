import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@vip/database';
import { AuthenticatedUser } from '../auth/auth.types';
import type { AnalysisResult } from '../jobs/ai-client.service';
import { scoreBand, ScoreBand, TribePillarScores } from '../jobs/tribe-scoring';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../storage/s3.service';

/** Report Builder output — score cards, signals, and an asset overview
 * assembled from VideoAnalytics.unifiedScore + the 4 analyzer JSONs, for
 * the Approval Desk UI (Milestone 8) and the Export PDF/JSON (exports
 * module) to both render from the same shape. */
export interface VideoReport {
  video: {
    id: string;
    title: string;
    mediaType: string;
    status: string;
    approvalStatus: string;
    targetPlatform: string;
    durationSec: number | null;
    width: number | null;
    height: number | null;
    thumbnailUrl: string | null;
  };
  scoreCards: {
    approvalScore: number | null;
    metaAdScore: number | null;
    creativeQuality: number | null;
    audienceFit: number | null;
    conversionSafety: number | null;
    roasEstimatePct: number | null;
  };
  /** GOOD/AVERAGE/BAD read of each scoreCards number above, computed
   * server-side from the same 82/68 thresholds ANALYSIS_RULES.md defines
   * (see tribe-scoring.ts's scoreBand) — the UI renders these, it doesn't
   * re-derive its own bands. */
  scoreBands: {
    approvalScore: ScoreBand | null;
    metaAdScore: ScoreBand | null;
    creativeQuality: ScoreBand | null;
    audienceFit: ScoreBand | null;
    conversionSafety: ScoreBand | null;
  };
  signals: {
    attentionPeak: number | null;
    humanGatePassed: boolean | null;
    claimSafetyRisk: string | null;
    colourBalanceScore: number | null;
  };
  /** The Tribe v2 scoring engine's 11 sub-scores (0-1) that combine into the
   * 3 pillars above — see tribe-scoring.ts's TribeSubScores. Exposed for the
   * Approval Desk's 60/30/10-style breakdown grid. */
  subScores: {
    attentionHold: number | null;
    colourBalance: number | null;
    typography: number | null;
    subjectPlacement: number | null;
    regionalLanguage: number | null;
    aspectFit: number | null;
    demographic: number | null;
    ctaClarity: number | null;
    claimSafety: number | null;
    offerStrength: number | null;
    ctaSignal: number | null;
  };
  /** The human-interaction-gate sub-thresholds behind `signals.humanGatePassed`. */
  humanGate: {
    readability: number | null;
    oneSecondClarity: number | null;
    actionClarity: number | null;
    passed: boolean | null;
  };
  roasReasoning: string | null;
  claimSafetyFlags: string[];
  assetOverview: {
    scene: Prisma.JsonValue;
    copy: Prisma.JsonValue;
    colour: Prisma.JsonValue;
    subject: Prisma.JsonValue;
  };
  copyCorrections: string[];
  nextActions: string[];
  generatedAt: string | null;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
  ) {}

  async getReport(user: AuthenticatedUser, videoId: string): Promise<VideoReport> {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, teamId: user.teamId },
      include: { analytics: true },
    });
    if (!video) throw new NotFoundException('Video not found');

    const unified = (video.analytics?.unifiedScore ?? {}) as {
      approvalScore?: number | null;
      metaAdScore?: number | null;
      pillars?: {
        creativeQuality?: number | null;
        audienceFit?: number | null;
        conversionSafety?: number | null;
      } | null;
      humanGate?: { passed?: boolean } | null;
      roas?: { estimate_pct?: number; reasoning?: string } | null;
      claimSafety?: { risk?: string; flags?: string[] } | null;
      attentionPeak?: number | null;
      copyCorrections?: string[];
      nextActions?: string[];
      generatedAt?: string;
    };

    const colour = video.analytics?.colourAnalysis as {
      balance?: { score?: number | null };
    } | null;

    // The full sub-score breakdown + human-gate sub-thresholds live on
    // rawAnalysis.tribe_v2_pillars (see pipeline.processor.ts's
    // runTribeAnalysis) — unifiedScore only carries the 3 pillar totals.
    const pillars = (
      video.analytics?.rawAnalysis as (AnalysisResult & { tribe_v2_pillars?: TribePillarScores }) | null
    )?.tribe_v2_pillars;

    const thumbnailKey = video.thumbnailKey ?? `${video.storageKey}/frames/0.jpg`;
    const thumbnailUrl = video.analytics
      ? await this.s3.presignDownload(thumbnailKey).catch(() => null)
      : null;

    return {
      video: {
        id: video.id,
        title: video.title,
        mediaType: video.mediaType,
        status: video.status,
        approvalStatus: video.approvalStatus,
        targetPlatform: video.targetPlatform,
        durationSec: video.durationSec,
        width: video.width,
        height: video.height,
        thumbnailUrl,
      },
      scoreCards: {
        approvalScore: unified.approvalScore ?? null,
        metaAdScore: unified.metaAdScore ?? null,
        creativeQuality: unified.pillars?.creativeQuality ?? null,
        audienceFit: unified.pillars?.audienceFit ?? null,
        conversionSafety: unified.pillars?.conversionSafety ?? null,
        roasEstimatePct: unified.roas?.estimate_pct ?? null,
      },
      scoreBands: {
        approvalScore: scoreBand(unified.approvalScore),
        metaAdScore: scoreBand(unified.metaAdScore),
        creativeQuality: scoreBand(unified.pillars?.creativeQuality),
        audienceFit: scoreBand(unified.pillars?.audienceFit),
        conversionSafety: scoreBand(unified.pillars?.conversionSafety),
      },
      signals: {
        attentionPeak: unified.attentionPeak ?? null,
        humanGatePassed: unified.humanGate?.passed ?? null,
        claimSafetyRisk: unified.claimSafety?.risk ?? null,
        colourBalanceScore: colour?.balance?.score ?? null,
      },
      subScores: {
        attentionHold: pillars?.subScores.attentionHold ?? null,
        colourBalance: pillars?.subScores.colourBalance ?? null,
        typography: pillars?.subScores.typography ?? null,
        subjectPlacement: pillars?.subScores.subjectPlacement ?? null,
        regionalLanguage: pillars?.subScores.regionalLanguage ?? null,
        aspectFit: pillars?.subScores.aspectFit ?? null,
        demographic: pillars?.subScores.demographic ?? null,
        ctaClarity: pillars?.subScores.ctaClarity ?? null,
        claimSafety: pillars?.subScores.claimSafety ?? null,
        offerStrength: pillars?.subScores.offerStrength ?? null,
        ctaSignal: pillars?.subScores.ctaSignal ?? null,
      },
      humanGate: {
        readability: pillars?.humanGate.readability ?? null,
        oneSecondClarity: pillars?.humanGate.oneSecondClarity ?? null,
        actionClarity: pillars?.humanGate.actionClarity ?? null,
        passed: pillars?.humanGate.passed ?? unified.humanGate?.passed ?? null,
      },
      roasReasoning: unified.roas?.reasoning ?? null,
      claimSafetyFlags: unified.claimSafety?.flags ?? [],
      assetOverview: {
        scene: video.analytics?.sceneAnalysis ?? null,
        copy: video.analytics?.copyAnalysis ?? null,
        colour: video.analytics?.colourAnalysis ?? null,
        subject: video.analytics?.subjectAnalysis ?? null,
      },
      copyCorrections: unified.copyCorrections ?? [],
      nextActions: unified.nextActions ?? [],
      generatedAt: unified.generatedAt ?? null,
    };
  }
}
