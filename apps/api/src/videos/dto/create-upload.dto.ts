import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { MediaType, Platform } from '@vip/database';

// 2 GB — matches typical short-form source file ceilings.
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export const ALLOWED_MIME_TYPES: Record<MediaType, readonly string[]> = {
  [MediaType.VIDEO]: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'],
  [MediaType.IMAGE]: ['image/jpeg', 'image/png', 'image/webp'],
  [MediaType.AUDIO]: ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/m4a'],
};

// Kept for backward compatibility — this was the only allowed list before
// multi-asset-type support.
export const ALLOWED_VIDEO_MIME_TYPES = ALLOWED_MIME_TYPES[MediaType.VIDEO];

/** Validates `mimeType` against the allowed list for this DTO's own
 * `mediaType` field (defaulting to VIDEO, same as the Prisma column) — a
 * plain @IsIn can't see a sibling field, so this is a small custom
 * class-validator constraint instead. */
function IsAllowedMimeTypeForMedia(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isAllowedMimeTypeForMedia',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const dto = args.object as CreateUploadDto;
          const mediaType = dto.mediaType ?? MediaType.VIDEO;
          return (
            typeof value === 'string' && ALLOWED_MIME_TYPES[mediaType].includes(value)
          );
        },
        defaultMessage(args: ValidationArguments) {
          const dto = args.object as CreateUploadDto;
          const mediaType = dto.mediaType ?? MediaType.VIDEO;
          return `mimeType must be one of [${ALLOWED_MIME_TYPES[mediaType].join(', ')}] for mediaType ${mediaType}`;
        },
      },
    });
  };
}

export class CreateUploadDto {
  @IsString()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsString()
  @MaxLength(255)
  filename!: string;

  // Defaults to VIDEO (matching the Prisma column) so existing callers that
  // predate multi-asset-type support don't need to change.
  @IsOptional()
  @IsEnum(MediaType)
  mediaType?: MediaType;

  @IsAllowedMimeTypeForMedia()
  mimeType!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_UPLOAD_BYTES)
  sizeBytes!: number;

  @IsOptional()
  @IsEnum(Platform)
  targetPlatform?: Platform;

  // Variant comparison: attach this upload to an existing test group and
  // label it (e.g. "Variant A") so it can be compared against siblings.
  @IsOptional()
  @IsString()
  variantGroupId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  variantLabel?: string;
}
