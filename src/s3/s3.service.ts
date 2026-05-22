import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { VIDEO_CONFIG, VideoConfigValues } from '../config/video.config';

@Injectable()
export class S3Service {
  private readonly client: S3Client;
  private readonly bucket: string;
  /** Original uploads + raw session ZIPs (short-lived bucket; lifecycle in AWS). */
  private readonly rawBucket: string;
  private readonly videoCfg: VideoConfigValues;

  constructor(private readonly config: ConfigService) {
    const region = this.config.getOrThrow<string>('AWS_REGION');
    const endpoint = this.config.get<string>('S3_ENDPOINT');
    this.bucket = this.config.getOrThrow<string>('S3_BUCKET');
    this.rawBucket = this.config.getOrThrow<string>('S3_RAW_BUCKET');
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
    await this.putFileStream(this.bucket, params);
  }

  /** Upload to the raw retention bucket (`S3_RAW_BUCKET`). */
  async uploadFileRaw(params: {
    key: string;
    filePath: string;
    contentType: string;
  }): Promise<void> {
    await this.putFileStream(this.rawBucket, params);
  }

  private async putFileStream(
    bucket: string,
    params: { key: string; filePath: string; contentType: string },
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
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
    return this.listKeysWithPrefixInBucket(this.bucket, prefix);
  }

  /** Lists object keys under prefix in the raw retention bucket. */
  async listKeysWithPrefixRaw(prefix: string): Promise<string[]> {
    return this.listKeysWithPrefixInBucket(this.rawBucket, prefix);
  }

  private async listKeysWithPrefixInBucket(
    bucket: string,
    prefix: string,
  ): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
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

  async deleteObject(key: string, bucket = this.bucket): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
  }

  async deleteObjects(keys: string[], bucket = this.bucket): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    const chunkSize = 1000;
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: chunk.map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
    }
  }

  /** Deletes all objects under `prefix` in the processed bucket. */
  async deletePrefix(prefix: string): Promise<void> {
    const keys = await this.listKeysWithPrefix(prefix);
    await this.deleteObjects(keys, this.bucket);
  }

  /** Deletes all objects under `prefix` in the raw retention bucket. */
  async deletePrefixRaw(prefix: string): Promise<void> {
    const keys = await this.listKeysWithPrefixRaw(prefix);
    await this.deleteObjects(keys, this.rawBucket);
  }

  async downloadToFile(key: string, destPath: string): Promise<void> {
    await this.downloadToFileFromBucket(this.bucket, key, destPath);
  }

  async downloadToFileRaw(key: string, destPath: string): Promise<void> {
    await this.downloadToFileFromBucket(this.rawBucket, key, destPath);
  }

  private async downloadToFileFromBucket(
    bucket: string,
    key: string,
    destPath: string,
  ): Promise<void> {
    const out = await this.client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
    const body = out.Body;
    if (!body) {
      throw new Error(`Empty S3 object body for key: ${key}`);
    }
    const bytes = await body.transformToByteArray();
    await writeFile(destPath, bytes);
  }

  /** Readable stream for GET object (caller must consume or destroy the stream). */
  async getObjectReadStream(key: string): Promise<{
    stream: Readable;
    contentLength?: number;
    contentType: string;
  }> {
    return this.getObjectReadStreamFromBucket(this.bucket, key);
  }

  /** Readable stream from the raw retention bucket. */
  async getObjectReadStreamRaw(key: string): Promise<{
    stream: Readable;
    contentLength?: number;
    contentType: string;
  }> {
    return this.getObjectReadStreamFromBucket(this.rawBucket, key);
  }

  private async getObjectReadStreamFromBucket(
    bucket: string,
    key: string,
  ): Promise<{
    stream: Readable;
    contentLength?: number;
    contentType: string;
  }> {
    const out = await this.client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
    const body = out.Body;
    if (body == null) {
      throw new Error(`Empty S3 object body for key: ${key}`);
    }
    return {
      stream: body as Readable,
      contentLength: out.ContentLength,
      contentType: out.ContentType ?? 'application/octet-stream',
    };
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

  /** Presigned GET for an object in the raw bucket. */
  async presignedGetUrlRaw(
    key: string,
    expiresInSeconds?: number,
  ): Promise<string> {
    const cmd = new GetObjectCommand({
      Bucket: this.rawBucket,
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
