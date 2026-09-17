import { IsBoolean, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

// Category is intentionally not editable here — the scoring engine
// (tribe-scoring.ts via rule-defaults.ts's reduceToWeights) looks rules up
// by id, not category, so changing category is structurally safe but has
// no real use case the Rule Editor UI needs (add/edit/toggle/reweight, per
// the whiteboard — not recategorize).
export class UpdateRuleDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsNumber()
  weight?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
