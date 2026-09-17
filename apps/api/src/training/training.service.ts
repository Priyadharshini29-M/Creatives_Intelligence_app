import { Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../storage/s3.service';

export interface TrainingDatasetRow {
  source_url: string;
  hook_rate?: number;
  hold_rate?: number;
  conversion_score?: number;
}

@Injectable()
export class TrainingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
  ) {}

  /** Builds the exact JSON shape apps/ai/scripts/train_tribe_head.py expects
   * (see its module docstring) from every video in this team that has a
   * recorded real-world outcome. Presigned URLs are valid for 1 hour — run
   * the `extract` step against this output soon after fetching it. */
  async exportDataset(user: AuthenticatedUser): Promise<TrainingDatasetRow[]> {
    const videos = await this.prisma.video.findMany({
      where: { teamId: user.teamId, outcome: { isNot: null } },
      include: { outcome: true },
    });

    return Promise.all(
      videos.map(async (video) => ({
        source_url: await this.s3.presignDownload(video.storageKey),
        ...(video.outcome!.hookRate != null && { hook_rate: video.outcome!.hookRate }),
        ...(video.outcome!.holdRate != null && { hold_rate: video.outcome!.holdRate }),
        ...(video.outcome!.conversionScore != null && {
          conversion_score: video.outcome!.conversionScore,
        }),
      })),
    );
  }
}
