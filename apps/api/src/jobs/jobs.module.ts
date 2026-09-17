import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { RulesModule } from '../rules/rules.module';
import { RulesController } from '../rules/rules.controller';
import { AiClientService } from './ai-client.service';
import { JobsService } from './jobs.service';
import { PipelineProcessor } from './pipeline.processor';
import { VIDEO_PIPELINE_QUEUE } from './pipeline.constants';

// RulesController lives here (not RulesModule) — see rules.module.ts's
// comment on why: it needs JobsService, and JobsModule already needs
// RulesService, so declaring it in RulesModule would be a circular import.
@Module({
  imports: [BullModule.registerQueue({ name: VIDEO_PIPELINE_QUEUE }), RulesModule],
  controllers: [RulesController],
  providers: [JobsService, AiClientService, PipelineProcessor],
  exports: [JobsService],
})
export class JobsModule {}
