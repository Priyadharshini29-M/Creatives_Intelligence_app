import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApprovalStatus } from '@vip/database';

export class RecordApprovalDto {
  @IsEnum(ApprovalStatus)
  status!: ApprovalStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
