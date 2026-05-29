import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { join, extname } from 'node:path';
import { rm } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { v4 as uuidv4, validate as uuidValidate, version as uuidVersion } from 'uuid';
import type { Express } from 'express';
import { Model } from 'mongoose';
import { VIDEO_CONFIG, VideoConfigValues } from '../config/video.config';
import { ffprobeJson, runFfmpeg } from '../ffmpeg/ffmpeg.helper';
import { planSnapshotTimes } from './snapshot-planner';
import { S3Service } from '../s3/s3.service';
import type { VideoJobMeta, VideoJobMetaSocialVariant } from './video-job-meta';
import {
  VideoJob,
  type VideoUploadSource,
} from './schemas/video-job.schema';
import { StudioService } from '../studio/studio.service';
import { SOCIAL_VIDEO_PROFILES } from './social-video-profiles';
import {
  extractSocialThumbnail,
  renderSocialVariant,
} from './social-video-render';
import type { RenderedSocialVariant } from './social-video.types';

export interface StartVideoJobResult {
  jobId: string;
  status: 'processing';
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof HttpException) {
    const res = err.getResponse();
    if (typeof res === 'string') return res;
    if (res && typeof res === 'object' && 'message' in res) {
      const m = (res as { message?: string | string[] }).message;
      if (Array.isArray(m)) return m.join(', ');
      if (typeof m === 'string') return m;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

type JobPipelineContext = {
  jobId: string;
  userId: string;
  inputPath: string;
  workDir: string;
  originalFilename: string;
  originalMime: string;
  surfSessionId: string | null;
  createdAt: string;
  watermarkPath: string;
  socialOutroLogoPath: string;
  videoCfg: VideoConfigValues;
};

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly s3: S3Service,
    private readonly studio: StudioService,
    @InjectModel(VideoJob.name)
    private readonly videoJobModel: Model<VideoJob>,
  ) {}

  /**
   * Validates upload, persists a `processing` job, then runs transcoding in the background
   * so the client can poll `GET /videos` after refresh.
   */
  async processUploadedFile(
    file: Express.Multer.File,
    userId: string,
    surfSessionId: string | null = null,
    uploadSource: VideoUploadSource = 'studio',
  ): Promise<StartVideoJobResult> {
    if (surfSessionId) {
      if (!uuidValidate(surfSessionId) || uuidVersion(surfSessionId) !== 4) {
        throw new BadRequestException('Invalid surfSessionId');
      }
      await this.studio.assertSessionOwnedByUser(userId, surfSessionId);
      if (uploadSource !== 'personal') {
        await this.studio.assertSessionOpenForUpload(userId, surfSessionId);
      } else {
        const session = await this.studio.getSession(userId, surfSessionId);
        if (session.sessionKind !== 'personal') {
          throw new BadRequestException(
            'Personal uploads must use a personal session',
          );
        }
      }
    }

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

    const socialOutroLogoPath = videoCfg.socialOutroLogoPath?.trim();
    if (!socialOutroLogoPath) {
      throw new InternalServerErrorException(
        'SOCIAL_OUTRO_LOGO_PATH is not configured',
      );
    }
    try {
      await access(socialOutroLogoPath);
    } catch {
      throw new InternalServerErrorException(
        `Social outro logo not readable: ${socialOutroLogoPath}`,
      );
    }

    const mime = file.mimetype ?? '';
    if (!videoCfg.allowedMimeTypes.includes(mime)) {
      throw new BadRequestException(
        `Unsupported MIME type: ${mime}. Allowed: ${videoCfg.allowedMimeTypes.join(', ')}`,
      );
    }

    const jobId = uuidv4();
    const createdAt = new Date().toISOString();
    const originalFilename = file.originalname ?? 'video';
    const inputPath = file.path;
    const workDir = join(inputPath, '..');

    const isPersonal = uploadSource === 'personal';
    await this.videoJobModel.create({
      userId,
      jobId,
      originalFilename,
      createdAt,
      surfSessionId: surfSessionId ?? null,
      status: 'processing',
      snapshotKeys: [],
      socialVariants: [],
      rawOriginalKey: null,
      uploadSource,
      discoverPublishedAt: isPersonal ? createdAt : null,
      claimStatus: isPersonal ? 'auto' : 'none',
      claimedAt: isPersonal ? createdAt : null,
    });

    const ctx: JobPipelineContext = {
      jobId,
      userId,
      inputPath,
      workDir,
      originalFilename,
      originalMime: mime,
      surfSessionId,
      createdAt,
      watermarkPath,
      socialOutroLogoPath,
      videoCfg,
    };

    void this.runJobPipeline(ctx).catch((err: unknown) => {
      const msg = extractErrorMessage(err);
      this.logger.error(`Job ${jobId} failed: ${msg}`, err instanceof Error ? err.stack : undefined);
      void this.videoJobModel
        .updateOne(
          { jobId },
          { $set: { status: 'failed', errorMessage: msg } },
        )
        .exec();
    });

    return { jobId, status: 'processing' };
  }

  private async runJobPipeline(ctx: JobPipelineContext): Promise<void> {
    const {
      jobId,
      userId,
      inputPath,
      workDir,
      originalFilename,
      originalMime,
      surfSessionId,
      createdAt,
      watermarkPath,
      socialOutroLogoPath,
      videoCfg,
    } = ctx;

    const bins = {
      ffmpeg: videoCfg.ffmpegBin,
      ffprobe: videoCfg.ffprobeBin,
    };

    const processedPath = join(workDir, 'processed.webm');

    try {
      let mainDurationSec: number;
      let hasAudio: boolean;
      try {
        const probe = await ffprobeJson(inputPath, bins);
        mainDurationSec = probe.durationSec;
        hasAudio = probe.hasAudio;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new BadRequestException(`Could not read video: ${msg}`);
      }

      let rawExt = extname(originalFilename).toLowerCase();
      if (!rawExt || rawExt === '.') {
        rawExt = '.bin';
      }
      const rawOriginalKey = `videos/${userId}/${jobId}/original${rawExt}`;
      await this.s3.uploadFileRaw({
        key: rawOriginalKey,
        filePath: inputPath,
        contentType: originalMime.trim()
          ? originalMime
          : 'application/octet-stream',
      });
      await this.videoJobModel
        .updateOne({ jobId }, { $set: { rawOriginalKey } })
        .exec();

      const snapshotTimes = planSnapshotTimes(mainDurationSec, {
        interiorStartRatio: videoCfg.interiorStartRatio,
        interiorEndRatio: videoCfg.interiorEndRatio,
        snapshotMinFrames: videoCfg.snapshotMinFrames,
        snapshotMaxFrames: videoCfg.snapshotMaxFrames,
        snapshotScaleShortSec: videoCfg.snapshotScaleShortSec,
        snapshotScaleLongSec: videoCfg.snapshotScaleLongSec,
      });

      const filterComplex =
        '[1:v][0:v]scale2ref=w=iw*15/100:h=ow/mdar[wm][main];[main][wm]overlay=W-w-24:24[outv]';

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
          ? [
              '-map',
              '0:a:0',
              '-c:a',
              'libopus',
              '-b:a',
              `${videoCfg.opusAudioBitrateK}k`,
            ]
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
        String(videoCfg.vp9CpuUsed),
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

      const prefix = `videos/${userId}/${jobId}`;
      const processedKey = `${prefix}/processed.webm`;

      await this.s3.uploadFile({
        key: processedKey,
        filePath: processedPath,
        contentType: 'video/webm',
      });

      const snapshotKeys: string[] = [];

      for (let i = 0; i < snapshotPaths.length; i++) {
        const key = `${prefix}/snapshots/${String(i + 1).padStart(3, '0')}.jpg`;
        await this.s3.uploadFile({
          key,
          filePath: snapshotPaths[i],
          contentType: 'image/jpeg',
        });
        snapshotKeys.push(key);
      }

      const socialVariants: RenderedSocialVariant[] = [];
      for (const profile of SOCIAL_VIDEO_PROFILES) {
        const { outputPath, durationSec: variantDurationSec } =
          await renderSocialVariant({
          bins,
          sourcePath: processedPath,
          workDir,
          profile,
          logoPath: socialOutroLogoPath,
          outroDurationSec: videoCfg.socialOutroDurationSec,
          outroFadeSec: 1.5,
          h264Crf: videoCfg.socialH264Crf,
          hasAudio,
          mainDurationSec,
        });

        const thumbPath = join(workDir, `${profile.kind}-thumb.jpg`);
        await extractSocialThumbnail(outputPath, thumbPath, bins, 1);

        const videoKey = `${prefix}/${profile.outputBasename}`;
        const thumbnailKey = `${prefix}/social/${profile.kind}-thumb.jpg`;
        await this.s3.uploadFile({
          key: videoKey,
          filePath: outputPath,
          contentType: 'video/mp4',
        });
        await this.s3.uploadFile({
          key: thumbnailKey,
          filePath: thumbPath,
          contentType: 'image/jpeg',
        });

        socialVariants.push({
          kind: profile.kind,
          label: profile.label,
          aspectRatio: profile.aspectRatio,
          videoKey,
          thumbnailKey,
          durationSec: variantDurationSec,
        });
      }

      const metaSocialVariants: VideoJobMetaSocialVariant[] = socialVariants.map(
        (v) => ({
          kind: v.kind,
          label: v.label,
          aspectRatio: v.aspectRatio,
          videoKey: v.videoKey,
          thumbnailKey: v.thumbnailKey,
          durationSec: v.durationSec,
        }),
      );

      const meta: VideoJobMeta = {
        userId,
        jobId,
        createdAt,
        originalFilename,
        processedKey,
        snapshotKeys,
        socialVariants: metaSocialVariants,
        surfSessionId: surfSessionId ?? null,
      };
      await this.s3.putJson(`${prefix}/meta.json`, meta);

      const existing = await this.videoJobModel.findOne({ jobId }).lean().exec();
      const publishPatch =
        existing?.uploadSource === 'personal'
          ? {
              discoverPublishedAt:
                existing.discoverPublishedAt ?? createdAt,
            }
          : {};

      await this.videoJobModel.updateOne(
        { jobId },
        {
          $set: {
            processedKey,
            snapshotKeys,
            socialVariants: metaSocialVariants,
            status: 'completed',
            ...publishPatch,
          },
          $unset: { errorMessage: 1 },
        },
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
