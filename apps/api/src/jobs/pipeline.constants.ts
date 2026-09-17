export const VIDEO_PIPELINE_QUEUE = 'video-pipeline';

export const PipelineStep = {
  PROBE: 'probe',
  FRAME_EXTRACTION: 'frame-extraction',
  AUDIO_EXTRACTION: 'audio-extraction',
  TRANSCRIPTION: 'transcription',
  // The 4 parallel analyzers (VIDEO/IMAGE only — AUDIO has no visual signal
  // and skips straight from TRANSCRIPTION to TRIBE_ANALYSIS). All 4 are
  // enqueued together and run concurrently (@Processor concurrency: 4); the
  // last one to finish enqueues TRIBE_ANALYSIS — see pipeline.processor.ts's
  // maybeAdvancePastFanout.
  VISION_ANALYSIS: 'vision-analysis',
  OCR_ANALYSIS: 'ocr-analysis',
  COLOR_ANALYSIS: 'color-analysis',
  SUBJECT_ANALYSIS: 'subject-analysis',
  TRIBE_ANALYSIS: 'tribe-analysis',
  SALES_ENGINE: 'sales-engine',
  PREDICTION: 'prediction',
  RECOMMENDATION: 'recommendation',
} as const;

// The 4 fan-out steps TRIBE_ANALYSIS waits on for VIDEO/IMAGE media.
export const ANALYZER_FANOUT_STEPS = [
  PipelineStep.VISION_ANALYSIS,
  PipelineStep.OCR_ANALYSIS,
  PipelineStep.COLOR_ANALYSIS,
  PipelineStep.SUBJECT_ANALYSIS,
] as const;

export type PipelineStepName = (typeof PipelineStep)[keyof typeof PipelineStep];

export interface PipelineJobData {
  videoId: string;
  /** Row in ProcessingJob mirroring this queue job for audit/UI. */
  processingJobId: string;
}
