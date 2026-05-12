import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { v4 as uuidv4 } from 'uuid';
import type { Express } from 'express';
import { VIDEO_CONFIG, VideoConfigValues } from '../config/video.config';
import { ffprobeJson, runFfmpeg } from '../ffmpeg/ffmpeg.helper';
import { planSnapshotTimes } from './snapshot-planner';
import { S3Service } from '../s3/s3.service';
import type { VideoJobMeta } from './video-job-meta';

export interface ProcessVideoResult {
  jobId: string;
  processedKey: string;
  processedUrl: string;
  snapshots: Array<{ key: string; url: string }>;
}

@Injectable()
export class VideoProcessingService {
  constructor(
    private readonly config: ConfigService,
    private readonly s3: S3Service,
  ) {}

  async processUploadedFile(file: Express.Multer.File): Promise<ProcessVideoResult> {
    const videoCfg = this.config.getOrThrow<VideoConfigValues>(VIDEO_CONFIG);
    const watermarkPath = videoCfg.watermarkImagePath;

    if (!watermarkPath?.trim()) {
      throw new InternalServerErrorException(
        'WATERMARK_IMAGE_PATH is not configured',
      );
    }

    try {
      await access(watermarkPath);
    } catch {
      throw new InternalServerErrorException(
        `Watermark file not readable: ${watermarkPath}`,
      );
    }

    const mime = file.mimetype ?? '';
    if (!videoCfg.allowedMimeTypes.includes(mime)) {
      throw new BadRequestException(
        `Unsupported MIME type: ${mime}. Allowed: ${videoCfg.allowedMimeTypes.join(', ')}`,
      );
    }

    const inputPath = file.path;
    const workDir = join(inputPath, '..');
    const bins = {
      ffmpeg: videoCfg.ffmpegBin,
      ffprobe: videoCfg.ffprobeBin,
    };

    try {
      const jobId = uuidv4();
      const processedPath = join(workDir, 'processed.webm');

      let durationSec: number;
      let hasAudio: boolean;
      try {
        const probe = await ffprobeJson(inputPath, bins);
        durationSec = probe.durationSec;
        hasAudio = probe.hasAudio;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new BadRequestException(`Could not read video: ${msg}`);
      }

      const snapshotTimes = planSnapshotTimes(durationSec, {
        interiorStartRatio: videoCfg.interiorStartRatio,
        interiorEndRatio: videoCfg.interiorEndRatio,
        snapshotMinFrames: videoCfg.snapshotMinFrames,
        snapshotMaxFrames: videoCfg.snapshotMaxFrames,
        snapshotScaleShortSec: videoCfg.snapshotScaleShortSec,
        snapshotScaleLongSec: videoCfg.snapshotScaleLongSec,
      });

      const filterComplex =
        '[1:v][0:v]scale2ref=w=iw*15/100:h=ow/mdar[wm][main];[main][wm]overlay=W-w-24:H-h-24[outv]';

      const vp9Args = [
        '-y',
        '-i',
        inputPath,
        '-i',
        watermarkPath,
        '-filter_complex',
        filterComplex,
        '-map',
        '[outv]',
        ...(hasAudio
          ? ['-map', '0:a:0', '-c:a', 'libopus', '-b:a', '96k']
          : ['-an']),
        '-c:v',
        'libvpx-vp9',
        '-crf',
        String(videoCfg.vp9Crf),
        '-b:v',
        '0',
        '-row-mt',
        '1',
        '-cpu-used',
        '1',
        processedPath,
      ];

      try {
        await runFfmpeg(vp9Args, bins);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new InternalServerErrorException(`Transcode failed: ${msg}`);
      }

      const snapshotPaths: string[] = [];
      for (let i = 0; i < snapshotTimes.length; i++) {
        const name = `snapshot_${String(i + 1).padStart(3, '0')}.jpg`;
        const outPath = join(workDir, name);
        snapshotPaths.push(outPath);
        try {
          await runFfmpeg(
            [
              '-y',
              '-i',
              processedPath,
              '-ss',
              String(snapshotTimes[i]),
              '-frames:v',
              '1',
              '-q:v',
              '2',
              outPath,
            ],
            bins,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new InternalServerErrorException(`Snapshot failed: ${msg}`);
        }
      }

      const prefix = `videos/${jobId}`;
      const processedKey = `${prefix}/processed.webm`;

      await this.s3.uploadFile({
        key: processedKey,
        filePath: processedPath,
        contentType: 'video/webm',
      });

      const snapshots: ProcessVideoResult['snapshots'] = [];

      for (let i = 0; i < snapshotPaths.length; i++) {
        const key = `${prefix}/snapshots/${String(i + 1).padStart(3, '0')}.jpg`;
        await this.s3.uploadFile({
          key,
          filePath: snapshotPaths[i],
          contentType: 'image/jpeg',
        });
        snapshots.push({
          key,
          url: await this.s3.presignedGetUrl(key),
        });
      }

      const processedUrl = await this.s3.presignedGetUrl(processedKey);

      const meta: VideoJobMeta = {
        jobId,
        createdAt: new Date().toISOString(),
        originalFilename: file.originalname ?? 'video',
        processedKey,
        snapshotKeys: snapshots.map((s) => s.key),
      };
      await this.s3.putJson(`${prefix}/meta.json`, meta);

      return {
        jobId,
        processedKey,
        processedUrl,
        snapshots,
      };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
