import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import { Rule } from '../rule-defaults';

const CATEGORIES: Rule['category'][] = [
  'pillar',
  'creative_quality',
  'audience_fit',
  'conversion_safety',
  'gate',
];

export class CreateRuleDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsIn(CATEGORIES)
  category!: Rule['category'];

  @IsNumber()
  weight!: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
