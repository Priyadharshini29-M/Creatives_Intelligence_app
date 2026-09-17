import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

// Matches Language Mode's own dropdown — "auto" plus the 4 regional
// languages the Regional & Language Fit panel's clusters cover (Tamil/
// Kannada/Telugu/Malayalam), keeping both panels' language vocabulary
// consistent rather than each inventing its own list.
const LANGUAGE_MODES = ['auto', 'ta', 'kn', 'te', 'ml', 'en'] as const;

export class CheckCopyQualityDto {
  @IsString()
  @MaxLength(5000)
  pastedCopy!: string;

  @IsOptional()
  @IsIn(LANGUAGE_MODES)
  languageMode?: string;
}
