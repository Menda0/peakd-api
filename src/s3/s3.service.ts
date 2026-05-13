import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream } from 'node:fs';
import { VIDEO_CONFIG, VideoConfigValues } from '../config/video.config';

@Injectable()
export class S3Service {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly videoCfg: VideoConfigValues;

  constructor(private readonly config: ConfigService) {
    const region = this.config.getOrThrow<string>('AWS_REGION');
    const endpoint = this.config.get<string>('S3_ENDPOINT');
    this.bucket = this.config.getOrThrow<string>('S3_BUCKET');
    this.videoCfg = this.config.getOrThrow<VideoConfigValues>(VIDEO_CONFIG);

    this.client = new S3Client({
      region,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
  }

  async uploadFile(params: {
    key: string;
    filePath: string;
    contentType: string;
  }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: params.key,
        Body: createReadStream(params.filePath),
        ContentType: params.contentType,
      }),
    );
  }

  async putObjectBytes(params: {
    key: string;
    body: Buffer;
    contentType: string;
  }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: params.key,
        Body: params.body,
        ContentType: params.contentType,
      }),
    );
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(value),
        ContentType: 'application/json; charset=utf-8',
      }),
    );
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      const raw = await out.Body?.transformToString();
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as T;
    } catch (e: unknown) {
      if (this.isNotFound(e)) {
        return null;
      }
      throw e;
    }
  }

  /** Lists object keys under prefix (paginated). */
  async listKeysWithPrefix(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of page.Contents ?? []) {
        if (obj.Key) {
          keys.push(obj.Key);
        }
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return keys;
  }

  async presignedGetUrl(
    key: string,
    expiresInSeconds?: number,
  ): Promise<string> {
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    const expiresIn =
      expiresInSeconds ?? this.videoCfg.presignedUrlExpirySeconds;
    return getSignedUrl(this.client, cmd, {
      expiresIn,
    });
  }

  /** Presigned PUT for browser uploads (e.g. partner avatars). */
  async presignedPutUrl(params: {
    key: string;
    contentType: string;
    expiresInSeconds?: number;
  }): Promise<string> {
    const expiresIn = params.expiresInSeconds ?? 300;
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: params.key,
      ContentType: params.contentType,
    });
    return getSignedUrl(this.client, cmd, { expiresIn });
  }

  private isNotFound(e: unknown): boolean {
    if (typeof e !== 'object' || e === null || !('name' in e)) {
      return false;
    }
    const name = (e as { name: string }).name;
    return name === 'NoSuchKey' || name === 'NotFound';
  }
}
