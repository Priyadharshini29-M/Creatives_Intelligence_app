import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApprovalStatus, Platform, VideoStatus } from '@vip/database';

export class ListVideosDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;

  @IsOptional()
  @IsEnum(VideoStatus)
  status?: VideoStatus;

  @IsOptional()
  @IsEnum(Platform)
  platform?: Platform;

  // Creative Queue filter — the Approval Desk's reviewer decision, separate
  // from `status` (pipeline progress).
  @IsOptional()
  @IsEnum(ApprovalStatus)
  approvalStatus?: ApprovalStatus;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
