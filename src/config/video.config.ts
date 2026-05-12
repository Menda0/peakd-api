import { registerAs } from '@nestjs/config';

export const VIDEO_CONFIG = 'video';

export interface VideoConfigValues {
  watermarkImagePath: string;
  /** Executable for ffmpeg (name on PATH or absolute path) */
  ffmpegBin: string;
  /** Executable for ffprobe (name on PATH or absolute path) */
  ffprobeBin: string;
  maxUploadBytes: number;
  interiorStartRatio: number;
  interiorEndRatio: number;
  snapshotMinFrames: number;
  snapshotMaxFrames: number;
  snapshotScaleShortSec: number;
  snapshotScaleLongSec: number;
  vp9Crf: number;
  presignedUrlExpirySeconds: number;
  allowedMimeTypes: string[];
}

export const videoConfig = registerAs(
  VIDEO_CONFIG,
  (): VideoConfigValues => ({
    watermarkImagePath: process.env.WATERMARK_IMAGE_PATH ?? '',
    ffmpegBin: (process.env.FFMPEG_PATH ?? 'ffmpeg').trim() || 'ffmpeg',
    ffprobeBin: (process.env.FFPROBE_PATH ?? 'ffprobe').trim() || 'ffprobe',
    maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 500) * 1024 * 1024,
    interiorStartRatio: Number(process.env.SNAPSHOT_INTERIOR_START_RATIO ?? 0.08),
    interiorEndRatio: Number(process.env.SNAPSHOT_INTERIOR_END_RATIO ?? 0.92),
    snapshotMinFrames: Number(process.env.SNAPSHOT_MIN_FRAMES ?? 5),
    snapshotMaxFrames: Number(process.env.SNAPSHOT_MAX_FRAMES ?? 10),
    snapshotScaleShortSec: Number(
      process.env.SNAPSHOT_SCALE_SHORT_SEC ?? 20,
    ),
    snapshotScaleLongSec: Number(
      process.env.SNAPSHOT_SCALE_LONG_SEC ?? 120,
    ),
    vp9Crf: Number(process.env.VP9_CRF ?? 32),
    presignedUrlExpirySeconds: Number(
      process.env.PRESIGNED_URL_EXPIRY_SECONDS ?? 3600,
    ),
    allowedMimeTypes: (
      process.env.ALLOWED_VIDEO_MIME_TYPES ??
      'video/mp4,video/quicktime,video/webm,video/x-msvideo,video/x-matroska'
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }),
);
