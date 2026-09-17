import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { VIDEO_PIPELINE_QUEUE } from '../jobs/pipeline.constants';
import { StorageModule } from '../storage/storage.module';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';

@Module({
  imports: [
    StorageModule,
    BullModule.registerQueue({ name: VIDEO_PIPELINE_QUEUE }),
  ],
  controllers: [WorkspaceController],
  providers: [WorkspaceService],
})
export class WorkspaceModule {}
