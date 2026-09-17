import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { AuthenticatedUser } from '../auth/auth.types';
import { Env } from '../config/env.validation';
import { VIDEO_PIPELINE_QUEUE } from '../jobs/pipeline.constants';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../storage/s3.service';

@Injectable()
export class WorkspaceService {
  private readonly aiServiceUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    @InjectQueue(VIDEO_PIPELINE_QUEUE) private readonly queue: Queue,
    config: ConfigService<Env, true>,
  ) {
    this.aiServiceUrl = config.get('AI_SERVICE_URL', { infer: true });
  }

  /** Subscription with usage; auto-provisions the FREE plan. */
  async billing(user: AuthenticatedUser) {
    const subscription = await this.prisma.subscription.upsert({
      where: { teamId: user.teamId },
      create: { teamId: user.teamId },
      update: {},
    });
    const analyzedTotal = await this.prisma.video.count({
      where: { teamId: user.teamId, status: 'ANALYZED' },
    });
    return { subscription, analyzedTotal };
  }

  async team(user: AuthenticatedUser) {
    return this.prisma.team.findUniqueOrThrow({
      where: { id: user.teamId },
      include: {
        members: { include: { user: true }, orderBy: { joinedAt: 'asc' } },
      },
    });
  }

  updateTeam(user: AuthenticatedUser, data: { name?: string; niche?: string }) {
    return this.prisma.team.update({
      where: { id: user.teamId },
      data: {
        ...(data.name ? { name: data.name } : {}),
        ...(data.niche !== undefined ? { niche: data.niche || null } : {}),
      },
    });
  }

  profile(user: AuthenticatedUser) {
    return this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  }

  updateProfile(
    user: AuthenticatedUser,
    data: { firstName?: string; lastName?: string; avatarUrl?: string },
  ) {
    return this.prisma.user.update({
      where: { id: user.id },
      data: {
        ...(data.firstName !== undefined
          ? { firstName: data.firstName || null }
          : {}),
        ...(data.lastName !== undefined
          ? { lastName: data.lastName || null }
          : {}),
        ...(data.avatarUrl !== undefined
          ? { avatarUrl: data.avatarUrl || null }
          : {}),
      },
    });
  }

  /** Live connection status of every backing service — real checks, no mocks. */
  async integrations() {
    const [database, queue, storage, aiService] = await Promise.all([
      this.check(() => this.prisma.$queryRaw`SELECT 1`),
      this.check(async () => {
        const client = await this.queue.client;
        // BullMQ's IRedisClient typing omits ping, but every backing
        // client (ioredis) implements it.
        await (client as unknown as { ping(): Promise<string> }).ping();
      }),
      this.check(() => this.s3.healthCheck()),
      this.check(async () => {
        const res = await fetch(`${this.aiServiceUrl}/health`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
      }),
    ]);

    return {
      connected: [
        {
          id: 'mysql',
          name: 'MySQL Database',
          detail: 'Prisma ORM',
          ...database,
        },
        {
          id: 'redis',
          name: 'Redis Queue',
          detail: 'BullMQ pipeline',
          ...queue,
        },
        {
          id: 'storage',
          name: 'Object Storage',
          detail: 'S3-compatible (MinIO)',
          ...storage,
        },
        {
          id: 'ai',
          name: 'AI Analysis Service',
          detail: 'FastAPI · Whisper · OpenCV',
          ...aiService,
        },
      ],
      // Honest placeholders: these need OAuth apps + external APIs.
      available: [
        { id: 'shopify', name: 'Shopify', detail: 'Product video sync' },
        {
          id: 'instagram',
          name: 'Instagram',
          detail: 'Publish + post-metrics',
        },
        { id: 'tiktok', name: 'TikTok', detail: 'Publish + post-metrics' },
        {
          id: 'youtube',
          name: 'YouTube Shorts',
          detail: 'Publish + post-metrics',
        },
      ],
    };
  }

  private async check(
    fn: () => Promise<unknown>,
  ): Promise<{ status: 'up' | 'down'; error?: string }> {
    try {
      await fn();
      return { status: 'up' };
    } catch (err) {
      return { status: 'down', error: (err as Error).message?.slice(0, 120) };
    }
  }
}
