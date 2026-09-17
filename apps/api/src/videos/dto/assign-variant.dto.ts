import { IsOptional, IsString, MaxLength } from 'class-validator';

export class AssignVariantDto {
  // Null clears the video's group; omit to leave the group unchanged while
  // only updating the label.
  @IsOptional()
  @IsString()
  variantGroupId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  variantLabel?: string | null;
}
