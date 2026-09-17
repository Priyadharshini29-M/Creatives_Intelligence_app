import { Body, Controller, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { VideoStatus } from '@vip/database';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JobsService } from '../jobs/jobs.service';
import { PipelineStep } from '../jobs/pipeline.constants';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRuleDto } from './dto/create-rule.dto';
import { UpdateRuleDto } from './dto/update-rule.dto';
import { RulesService } from './rules.service';

/**
 * Rule Editor backend — add/edit/toggle rules and weights (saved to
 * rules.json via RulesService), plus the rescore trigger the whiteboard's
 * feedback loop ends on. Rules are global, not team-scoped (one shared
 * rules.json), matching how RulesService already works; `rescore` still
 * scopes *which videos* get re-enqueued to the caller's own team.
 */
@Controller('rules')
export class RulesController {
  constructor(
    private readonly rules: RulesService,
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  getRules() {
    return this.rules.getRules();
  }

  @Post()
  async addRule(@Body() dto: CreateRuleDto) {
    const rules = await this.rules.getRules();
    const newRule = {
      id: `custom-${randomUUID()}`,
      name: dto.name,
      category: dto.category,
      weight: dto.weight,
      enabled: dto.enabled ?? true,
    };
    await this.rules.saveRules([...rules, newRule]);
    return newRule;
  }

  @Patch(':id')
  async updateRule(@Param('id') id: string, @Body() dto: UpdateRuleDto) {
    const rules = await this.rules.getRules();
    const index = rules.findIndex((r) => r.id === id);
    if (index === -1) throw new NotFoundException('Rule not found');

    const updatedRule = {
      ...rules[index],
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.weight !== undefined && { weight: dto.weight }),
      ...(dto.enabled !== undefined && { enabled: dto.enabled }),
    };
    const updated = [...rules];
    updated[index] = updatedRule;
    await this.rules.saveRules(updated);
    return updatedRule;
  }

  /** "Tribe v2 re-runs on saved videos" — re-enqueues TRIBE_ANALYSIS (not
   * the full 4-analyzer fan-out; scene/copy/colour/subject JSONs are
   * already persisted and don't need re-running) for every ANALYZED video
   * on the caller's team, so the just-edited weights take effect. */
  @Post('rescore')
  async rescore(@CurrentUser() user: AuthenticatedUser) {
    const videos = await this.prisma.video.findMany({
      where: { teamId: user.teamId, status: VideoStatus.ANALYZED },
      select: { id: true },
    });
    for (const video of videos) {
      await this.jobs.enqueueStep(PipelineStep.TRIBE_ANALYSIS, video.id);
    }
    return { enqueued: videos.length };
  }
}
