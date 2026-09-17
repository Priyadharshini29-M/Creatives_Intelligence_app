import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

// S3Service comes from the @Global() StorageModule — no explicit import
// needed, matching the rest of the codebase's convention (e.g. VideosModule).
@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
