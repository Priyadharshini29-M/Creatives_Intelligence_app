import { Module } from '@nestjs/common';
import { RulesService } from './rules.service';

// RulesController is deliberately NOT declared here — it needs JobsService
// (for the rescore endpoint), and JobsModule already needs RulesService (for
// PipelineProcessor's scoring engine). Declaring the controller in this
// module would make that a circular module import; it's registered in
// JobsModule instead, which already imports this module one-way.
@Module({
  providers: [RulesService],
  exports: [RulesService],
})
export class RulesModule {}
