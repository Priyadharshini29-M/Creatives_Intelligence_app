import { IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const OUTCOME_SOURCES = ['youtube_studio', 'meta_insights', 'tiktok_analytics', 'manual'] as const;
export type OutcomeSource = (typeof OUTCOME_SOURCES)[number];

// Real-world numbers only — never a prediction. See VideoOutcome in
// packages/database/prisma/schema.prisma.
export class RecordOutcomeDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  hookRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  holdRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  conversionScore?: number;

  @IsIn(OUTCOME_SOURCES)
  source: OutcomeSource;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
