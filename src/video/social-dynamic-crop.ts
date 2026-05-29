import type { FfmpegBinaries } from '../ffmpeg/ffmpeg.helper';
import { runFfmpeg } from '../ffmpeg/ffmpeg.helper';
import {
  buildCropTimeExpression,
  fallbackStaticCrop,
  planCropKeyframes,
} from './social-crop-planner';
import type { SmartCropOptions, SubjectTrack } from './social-subject.types';

export type ReframeOptions = {
  bins: FfmpegBinaries;
  sourcePath: string;
  workDir: string;
  outputPath: string;
  targetWidth: number;
  targetHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  durationSec: number;
  h264Crf: number;
  hasAudio: boolean;
  track: SubjectTrack | null;
  smartCrop: SmartCropOptions;
};

export async function reframeVideoToTarget(
  opts: ReframeOptions,
): Promise<void> {
  const {
    bins,
    sourcePath,
    workDir,
    outputPath,
    targetWidth,
    targetHeight,
    sourceWidth,
    sourceHeight,
    durationSec,
    h264Crf,
    hasAudio,
    track,
    smartCrop,
  } = opts;

  let xExpr = '0';
  let yExpr = '0';

  if (!smartCrop.enabled || sourceWidth <= 0 || sourceHeight <= 0) {
    const filter = `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},setsar=1,fps=30`;
    await runFfmpeg(
      [
        '-y',
        '-i',
        sourcePath,
        '-vf',
        filter,
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        String(h264Crf),
        '-pix_fmt',
        'yuv420p',
        ...(hasAudio
          ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2']
          : ['-an']),
        '-movflags',
        '+faststart',
        outputPath,
      ],
      bins,
    );
    return;
  }

  if (track && track.samples.length > 0 && smartCrop.enabled) {
    const keyframes = planCropKeyframes(
      track.samples,
      sourceWidth,
      sourceHeight,
      targetWidth,
      targetHeight,
      durationSec,
      smartCrop.sendcmdIntervalSec,
      80,
    );
    xExpr = buildCropTimeExpression(keyframes, 'x');
    yExpr = buildCropTimeExpression(keyframes, 'y');
  } else if (smartCrop.enabled) {
    const fallback = fallbackStaticCrop(
      sourceWidth,
      sourceHeight,
      targetWidth,
      targetHeight,
      smartCrop.fallbackCenterY,
    );
    xExpr = String(Math.round(fallback.x));
    yExpr = String(Math.round(fallback.y));
  }

  const scaleLabel = `scaled_${targetWidth}x${targetHeight}`;
  const filterComplex = [
    `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,setsar=1,fps=30[${scaleLabel}]`,
    `[${scaleLabel}]crop=${targetWidth}:${targetHeight}:x='${xExpr}':y='${yExpr}',format=yuv420p[vout]`,
  ].join(';');

  await runFfmpeg(
    [
      '-y',
      '-i',
      sourcePath,
      '-filter_complex',
      filterComplex,
      '-map',
      '[vout]',
      ...(hasAudio ? ['-map', '0:a:0'] : []),
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      String(h264Crf),
      '-pix_fmt',
      'yuv420p',
      ...(hasAudio
        ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2']
        : ['-an']),
      '-movflags',
      '+faststart',
      outputPath,
    ],
    bins,
  );
}
