import { join } from 'node:path';
import type { FfmpegBinaries } from '../ffmpeg/ffmpeg.helper';
import { runFfmpeg } from '../ffmpeg/ffmpeg.helper';
import { buildSocialOutroCardPng } from './social-outro-card';
import type { SocialVideoProfile } from './social-video.types';

export type SocialRenderOptions = {
  bins: FfmpegBinaries;
  /** Pre-reframed main clip (target aspect, no outro). */
  reframedSourcePath: string;
  workDir: string;
  profile: SocialVideoProfile;
  logoPath: string;
  outroDurationSec: number;
  outroFadeSec: number;
  h264Crf: number;
  hasAudio: boolean;
  mainDurationSec: number;
};

/**
 * Appends branded outro to a pre-reframed clip and muxes audio.
 */
export async function renderSocialVariant(
  opts: SocialRenderOptions,
): Promise<{ outputPath: string; durationSec: number }> {
  const {
    bins,
    reframedSourcePath,
    workDir,
    profile,
    logoPath,
    outroDurationSec,
    outroFadeSec,
    h264Crf,
    hasAudio,
    mainDurationSec,
  } = opts;

  const { kind, width, height } = profile;
  const outroCardPath = join(workDir, `${kind}-outro-card.png`);
  const outroPath = join(workDir, `${kind}-outro.mp4`);
  const outputPath = join(workDir, profile.outputBasename);

  const padColor = '0x0d1117';

  await buildSocialOutroCardPng({
    width,
    height,
    logoPath,
    outputPath: outroCardPath,
  });

  const fadeDur = Math.min(outroFadeSec, outroDurationSec);
  const outroFilter = [
    `[1:v]format=rgba,fade=t=in:st=0:d=${fadeDur}:alpha=1[card]`,
    `[0:v][card]overlay=0:0:format=auto[vout]`,
  ].join(';');

  const outroArgs = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${padColor}:s=${width}x${height}:d=${outroDurationSec}`,
    '-loop',
    '1',
    '-i',
    outroCardPath,
    '-filter_complex',
    outroFilter,
    '-map',
    '[vout]',
    '-t',
    String(outroDurationSec),
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    String(h264Crf),
    '-pix_fmt',
    'yuv420p',
    '-an',
    '-movflags',
    '+faststart',
    outroPath,
  ];
  await runFfmpeg(outroArgs, bins);

  const totalDuration = mainDurationSec + outroDurationSec;
  const audioConcat = hasAudio
    ? `[0:a]asetpts=PTS-STARTPTS[maina];anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${outroDurationSec}[outroa];[maina][outroa]concat=n=2:v=0:a=1[aout]`
    : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${totalDuration}[aout]`;

  const concatFilter = `[0:v][1:v]concat=n=2:v=1:a=0[vout];${audioConcat}`;

  const concatArgs = [
    '-y',
    '-i',
    reframedSourcePath,
    '-i',
    outroPath,
    '-filter_complex',
    concatFilter,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    String(h264Crf),
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    outputPath,
  ];
  await runFfmpeg(concatArgs, bins);

  return { outputPath, durationSec: totalDuration };
}

export async function extractSocialThumbnail(
  videoPath: string,
  thumbnailPath: string,
  bins: FfmpegBinaries,
  atSec = 1,
): Promise<void> {
  await runFfmpeg(
    [
      '-y',
      '-i',
      videoPath,
      '-ss',
      String(Math.max(0, atSec)),
      '-frames:v',
      '1',
      '-q:v',
      '2',
      thumbnailPath,
    ],
    bins,
  );
}
