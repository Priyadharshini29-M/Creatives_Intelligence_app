import { Module } from '@nestjs/common';
import { AiClientService } from '../jobs/ai-client.service';
import { LanguageIntelligenceController } from './language-intelligence.controller';
import { LanguageIntelligenceService } from './language-intelligence.service';

// AiClientService is stateless (its only dependency is the globally
// available ConfigService) — declared here directly rather than importing
// JobsModule, which doesn't export it (see jobs.module.ts: only JobsService
// is exported). A second instance costs nothing.
@Module({
  controllers: [LanguageIntelligenceController],
  providers: [LanguageIntelligenceService, AiClientService],
})
export class LanguageIntelligenceModule {}
