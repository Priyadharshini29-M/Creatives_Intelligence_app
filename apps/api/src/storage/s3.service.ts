import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.validation';

const UPLOAD_URL_TTL_SEC = 15 * 60;
const DOWNLOAD_URL_TTL_SEC = 60 * 60;

@Injectable()
export class S3Service {
  private readonly client: S3Client;
  private readonly presignClient: S3Client;
  readonly videosBucket: string;

  constructor(config: ConfigService<Env, true>) {
    const clientOptions = {
      region: config.get('S3_REGION', { infer: true }),
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY', { infer: true }),
        secretAccessKey: config.get('S3_SECRET_KEY', { infer: true }),
      },
    };
    this.client = new S3Client({
      ...clientOptions,
      endpoint: config.get('S3_ENDPOINT', { infer: true }),
    });
    this.presignClient = new S3Client({
      ...clientOptions,
      endpoint:
        config.get('S3_PUBLIC_ENDPOINT', { infer: true }) ??
        config.get('S3_ENDPOINT', { infer: true }),
    });
    this.videosBucket = config.get('S3_BUCKET_VIDEOS', { infer: true });
  }

  /** Presigned PUT so the browser uploads directly to storage. */
  presignUpload(key: string, contentType: string): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new PutObjectCommand({
        Bucket: this.videosBucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: UPLOAD_URL_TTL_SEC },
    );
  }

  /** Presigned GET for playback and for the AI service to read sources. */
  presignDownload(key: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.videosBucket, Key: key }),
      { expiresIn: DOWNLOAD_URL_TTL_SEC },
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.videosBucket, Key: key }),
    );
  }

  /** Throws when the bucket is unreachable — used by integration status. */
  async healthCheck(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.videosBucket }));
  }
}
