import { registerAs } from '@nestjs/config';
import { join } from 'node:path';

export const VIDEO_CONFIG = 'video';

export interface VideoConfigValues {
  watermarkImagePath: string;
  /** Logo for social outro card (defaults to assets/social-outro-logo.png). */
  socialOutroLogoPath: string;
  /** Branded end-card duration appended to social MP4 exports. */
  socialOutroDurationSec: number;
  /** H.264 CRF for social MP4 variants (lower = higher quality). */
  socialH264Crf: number;
  socialSmartCropEnabled: boolean;
  socialTrackSampleFps: number;
  socialTrackMaxSampleFrames: number;
  socialTrackSmoothing: number;
  socialTrackMinConfidence: number;
  socialTrackMaxPanPxPerSec: number;
  socialTrackFallbackCenterY: number;
  socialTrackSendcmdIntervalSec: number;
  socialDetectorModelPath: string;
  highlightSnapshotsEnabled: boolean;
  highlightSampleFps: number;
  highlightMaxSampleFrames: number;
  highlightMinPersonArea: number;
  highlightWeightPerson: number;
  highlightWeightMotion: number;
  highlightWeightSharpness: number;
  highlightWeightCenter: number;
  highlightFallbackHitRate: number;
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
  /** libvpx-vp9 speed (0 = slowest / best compression efficiency, 5 = fastest). */
  vp9CpuUsed: number;
  /** Opus audio bitrate in kb/s when source has audio */
  opusAudioBitrateK: number;
  presignedUrlExpirySeconds: number;
  allowedMimeTypes: string[];
}

export const videoConfig = registerAs(
  VIDEO_CONFIG,
  (): VideoConfigValues => ({
    watermarkImagePath: process.env.WATERMARK_IMAGE_PATH ?? '',
    socialOutroLogoPath:
      process.env.SOCIAL_OUTRO_LOGO_PATH?.trim() ||
      join(process.cwd(), 'assets/social-outro-logo.png'),
    socialOutroDurationSec: Math.min(
      8,
      Math.max(1, Number(process.env.SOCIAL_OUTRO_DURATION_SEC ?? 3)),
    ),
    socialH264Crf: Math.min(
      35,
      Math.max(18, Number(process.env.SOCIAL_H264_CRF ?? 23)),
    ),
    socialSmartCropEnabled:
      (process.env.SOCIAL_SMART_CROP_ENABLED ?? 'true').trim().toLowerCase() !==
      'false',
    socialTrackSampleFps: Math.min(
      10,
      Math.max(1, Number(process.env.SOCIAL_TRACK_SAMPLE_FPS ?? 4)),
    ),
    socialTrackMaxSampleFrames: Math.min(
      240,
      Math.max(10, Number(process.env.SOCIAL_TRACK_MAX_SAMPLE_FRAMES ?? 120)),
    ),
    socialTrackSmoothing: Math.min(
      1,
      Math.max(0.05, Number(process.env.SOCIAL_TRACK_SMOOTHING ?? 0.25)),
    ),
    socialTrackMinConfidence: Math.min(
      0.95,
      Math.max(0.1, Number(process.env.SOCIAL_TRACK_MIN_CONFIDENCE ?? 0.45)),
    ),
    socialTrackMaxPanPxPerSec: Math.min(
      4000,
      Math.max(50, Number(process.env.SOCIAL_TRACK_MAX_PAN_PX_PER_SEC ?? 900)),
    ),
    socialTrackFallbackCenterY: Math.min(
      0.9,
      Math.max(0.1, Number(process.env.SOCIAL_TRACK_FALLBACK_CENTER_Y ?? 0.58)),
    ),
    socialTrackSendcmdIntervalSec: Math.min(
      1,
      Math.max(0.05, Number(process.env.SOCIAL_TRACK_SENDCMD_INTERVAL_SEC ?? 0.1)),
    ),
    socialDetectorModelPath:
      process.env.SOCIAL_DETECTOR_MODEL_PATH?.trim() ||
      join(process.cwd(), 'assets/models/yolov8n.onnx'),
    highlightSnapshotsEnabled:
      (process.env.HIGHLIGHT_SNAPSHOTS_ENABLED ?? 'true')
        .trim()
        .toLowerCase() !== 'false',
    highlightSampleFps: Math.min(
      10,
      Math.max(1, Number(process.env.HIGHLIGHT_SAMPLE_FPS ?? 4)),
    ),
    highlightMaxSampleFrames: Math.min(
      240,
      Math.max(10, Number(process.env.HIGHLIGHT_MAX_SAMPLE_FRAMES ?? 120)),
    ),
    highlightMinPersonArea: Math.min(
      0.5,
      Math.max(0.001, Number(process.env.HIGHLIGHT_MIN_PERSON_AREA ?? 0.008)),
    ),
    highlightWeightPerson: Math.max(
      0,
      Number(process.env.HIGHLIGHT_WEIGHT_PERSON ?? 0.4),
    ),
    highlightWeightMotion: Math.max(
      0,
      Number(process.env.HIGHLIGHT_WEIGHT_MOTION ?? 0.35),
    ),
    highlightWeightSharpness: Math.max(
      0,
      Number(process.env.HIGHLIGHT_WEIGHT_SHARPNESS ?? 0.15),
    ),
    highlightWeightCenter: Math.max(
      0,
      Number(process.env.HIGHLIGHT_WEIGHT_CENTER ?? 0.1),
    ),
    highlightFallbackHitRate: Math.min(
      1,
      Math.max(0, Number(process.env.HIGHLIGHT_FALLBACK_HIT_RATE ?? 0.5)),
    ),
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
    vp9Crf: Math.min(
      50,
      Math.max(10, Number(process.env.VP9_CRF ?? 37)),
    ),
    vp9CpuUsed: Math.min(
      5,
      Math.max(0, Math.floor(Number(process.env.VP9_CPU_USED ?? 0))),
    ),
    opusAudioBitrateK: Math.min(
      256,
      Math.max(24, Number(process.env.OPUS_AUDIO_BITRATE_K ?? 64)),
    ),
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
