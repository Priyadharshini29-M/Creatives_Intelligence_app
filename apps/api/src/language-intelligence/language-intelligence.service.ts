import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@vip/database';
import { AuthenticatedUser } from '../auth/auth.types';
import {
  AiClientService,
  CopyQualityResult,
  RegionalFitResult,
} from '../jobs/ai-client.service';
import { PrismaService } from '../prisma/prisma.service';

export interface CopyQualityCheckDto {
  languageMode: string;
  pastedCopy: string;
  spellingScore: number | null;
  grammarScore: number | null;
  logicScore: number | null;
  clarityScore: number | null;
  findings: string[];
  checkedAt: string;
}

export interface RegionalFitDto {
  cities: {
    city: string;
    state: string;
    language: string;
    fitPct: number | null;
  }[];
  clusters: { state: string; description: string }[];
  sourceText: string;
}

/** Approval Desk's "Language Mode" copy QC + "Regional & Language Fit"
 * panels — both on-demand (reviewer-triggered), not automatic pipeline
 * steps, so they live in their own module rather than pipeline.processor.ts
 * (see the AI-service module docstrings for why: each is an extra Gemini
 * call this session's own daily-quota exhaustion already showed is a real
 * cost to add to every single video's automatic analysis). */
@Injectable()
export class LanguageIntelligenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiClientService,
  ) {}

  private async findVideoOrThrow(user: AuthenticatedUser, videoId: string) {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, teamId: user.teamId },
    });
    if (!video) throw new NotFoundException('Video not found');
    return video;
  }

  async getCopyQualityCheck(
    user: AuthenticatedUser,
    videoId: string,
  ): Promise<CopyQualityCheckDto | null> {
    await this.findVideoOrThrow(user, videoId);
    const row = await this.prisma.copyQualityCheck.findUnique({
      where: { videoId },
    });
    return row ? this.toCopyQualityDto(row) : null;
  }

  async checkCopyQuality(
    user: AuthenticatedUser,
    videoId: string,
    input: { pastedCopy: string; languageMode?: string },
  ): Promise<CopyQualityCheckDto> {
    await this.findVideoOrThrow(user, videoId);
    const languageMode = input.languageMode ?? 'auto';
    const result: CopyQualityResult = await this.ai.analyzeCopyQuality(
      input.pastedCopy,
      languageMode,
    );

    const row = await this.prisma.copyQualityCheck.upsert({
      where: { videoId },
      create: {
        videoId,
        languageMode,
        pastedCopy: input.pastedCopy,
        spellingScore: result.spelling,
        grammarScore: result.grammar,
        logicScore: result.logic,
        clarityScore: result.clarity,
        findings: result.findings,
      },
      update: {
        languageMode,
        pastedCopy: input.pastedCopy,
        spellingScore: result.spelling,
        grammarScore: result.grammar,
        logicScore: result.logic,
        clarityScore: result.clarity,
        findings: result.findings,
      },
    });
    return this.toCopyQualityDto(row);
  }

  async getRegionalFit(
    user: AuthenticatedUser,
    videoId: string,
  ): Promise<RegionalFitDto | null> {
    await this.findVideoOrThrow(user, videoId);
    const analytics = await this.prisma.videoAnalytics.findUnique({
      where: { videoId },
    });
    const cached = analytics?.regionalFit as {
      cities: RegionalFitResult['cities'];
      clusters: RegionalFitResult['clusters'];
      sourceText: string;
    } | null;
    if (!cached) return null;
    return this.toRegionalFitDto(cached, cached.sourceText);
  }

  /** Gathers whatever text this video's pipeline has already detected
   * (OCR'd on-screen copy + the transcript) as the read for regional/city
   * fit — a reviewer doesn't paste anything for this panel, unlike Copy
   * Quality; it's automatic once requested. */
  async analyzeRegionalFit(
    user: AuthenticatedUser,
    videoId: string,
  ): Promise<RegionalFitDto> {
    await this.findVideoOrThrow(user, videoId);
    const [analytics, transcript] = await Promise.all([
      this.prisma.videoAnalytics.findUnique({ where: { videoId } }),
      this.prisma.transcript.findUnique({ where: { videoId } }),
    ]);

    const ocrText =
      (analytics?.copyAnalysis as { text?: string } | null)?.text ?? '';
    const sourceText = [ocrText, transcript?.fullText]
      .filter(Boolean)
      .join('\n\n')
      .trim();

    const result: RegionalFitResult =
      await this.ai.analyzeRegionalFit(sourceText);
    const payload = {
      cities: result.cities,
      clusters: result.clusters,
      sourceText,
    };

    await this.prisma.videoAnalytics.update({
      where: { videoId },
      data: { regionalFit: payload },
    });

    return this.toRegionalFitDto(payload, sourceText);
  }

  private toCopyQualityDto(row: {
    languageMode: string;
    pastedCopy: string;
    spellingScore: number | null;
    grammarScore: number | null;
    logicScore: number | null;
    clarityScore: number | null;
    findings: Prisma.JsonValue;
    checkedAt: Date;
  }): CopyQualityCheckDto {
    return {
      languageMode: row.languageMode,
      pastedCopy: row.pastedCopy,
      spellingScore: row.spellingScore,
      grammarScore: row.grammarScore,
      logicScore: row.logicScore,
      clarityScore: row.clarityScore,
      findings: (row.findings as string[]) ?? [],
      checkedAt: row.checkedAt.toISOString(),
    };
  }

  private toRegionalFitDto(
    payload: {
      cities: RegionalFitResult['cities'];
      clusters: RegionalFitResult['clusters'];
    },
    sourceText: string,
  ): RegionalFitDto {
    return {
      cities: payload.cities.map((c) => ({
        city: c.city,
        state: c.state,
        language: c.language,
        fitPct: c.fit_pct,
      })),
      clusters: payload.clusters,
      sourceText,
    };
  }
}
