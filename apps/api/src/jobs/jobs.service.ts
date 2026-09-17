import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { JobStatus, JobType } from '@vip/database';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  PipelineJobData,
  PipelineStep,
  PipelineStepName,
  VIDEO_PIPELINE_QUEUE,
} from './pipeline.constants';

const STEP_TO_JOB_TYPE: Record<PipelineStepName, JobType> = {
  [PipelineStep.PROBE]: JobType.PROBE,
  [PipelineStep.FRAME_EXTRACTION]: JobType.FRAME_EXTRACTION,
  [PipelineStep.AUDIO_EXTRACTION]: JobType.AUDIO_EXTRACTION,
  [PipelineStep.TRANSCRIPTION]: JobType.TRANSCRIPTION,
  [PipelineStep.VISION_ANALYSIS]: JobType.VISION_ANALYSIS,
  [PipelineStep.OCR_ANALYSIS]: JobType.OCR_ANALYSIS,
  [PipelineStep.COLOR_ANALYSIS]: JobType.COLOR_ANALYSIS,
  [PipelineStep.SUBJECT_ANALYSIS]: JobType.SUBJECT_ANALYSIS,
  [PipelineStep.TRIBE_ANALYSIS]: JobType.TRIBE_ANALYSIS,
  [PipelineStep.SALES_ENGINE]: JobType.SALES_ENGINE,
  [PipelineStep.PREDICTION]: JobType.PREDICTION,
  [PipelineStep.RECOMMENDATION]: JobType.RECOMMENDATION,
};

@Injectable()
export class JobsService {
  constructor(
    @InjectQueue(VIDEO_PIPELINE_QUEUE)
    private readonly queue: Queue<PipelineJobData>,
    private readonly prisma: PrismaService,
  ) {}

  /** First pipeline step after a completed upload. */
  enqueueProbe(videoId: string, delayMs?: number) {
    return this.enqueueStep(PipelineStep.PROBE, videoId, delayMs);
  }

  async enqueueStep(step: PipelineStepName, videoId: string, delayMs?: number) {
    const processingJob = await this.prisma.processingJob.create({
      data: {
        type: STEP_TO_JOB_TYPE[step],
        status: JobStatus.QUEUED,
        videoId,
      },
    });

    const queueJob = await this.queue.add(
      step,
      { videoId, processingJobId: processingJob.id },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        delay: delayMs ?? 0,
        removeOnComplete: { age: 24 * 3600 },
        removeOnFail: false,
      },
    );

    await this.prisma.processingJob.update({
      where: { id: processingJob.id },
      data: { queueJobId: queueJob.id },
    });

    return processingJob;
  }

  // Clears any error from a prior failed attempt on this same row — BullMQ
  // retries reuse the ProcessingJob id, so without this a step that failed
  // once and then succeeded on retry still shows the old error text even
  // though its status reads COMPLETED.
  markRunning(processingJobId: string) {
    return this.prisma.processingJob.update({
      where: { id: processingJobId },
      data: { status: JobStatus.RUNNING, startedAt: new Date(), error: null },
    });
  }

  setProgress(processingJobId: string, progress: number) {
    return this.prisma.processingJob.update({
      where: { id: processingJobId },
      data: { progress: Math.min(100, Math.max(0, Math.round(progress))) },
    });
  }

  markCompleted(processingJobId: string) {
    return this.prisma.processingJob.update({
      where: { id: processingJobId },
      data: { status: JobStatus.COMPLETED, progress: 100, completedAt: new Date() },
    });
  }

  markFailed(processingJobId: string, error: string) {
    return this.prisma.processingJob.update({
      where: { id: processingJobId },
      data: { status: JobStatus.FAILED, error, completedAt: new Date() },
    });
  }
}
