import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { FfmpegBinaries } from '../ffmpeg/ffmpeg.helper';
import { ffprobeJson, runFfmpeg } from '../ffmpeg/ffmpeg.helper';
import {
  applyCompositeScores,
  computeMotionScore,
  computeSharpnessScore,
  loadGrayscaleThumb,
  rawPersonScore,
} from './highlight-frame-scorer';
import type { HighlightScoredFrame, HighlightSnapshotOptions } from './highlight.types';
import { detectLargestPerson } from './social-subject-detector';

export async function extractSampleFrames(
  videoPath: string,
  framesDir: string,
  sampleFps: number,
  maxFrames: number,
  bins: FfmpegBinaries,
): Promise<string[]> {
  await mkdir(framesDir, { recursive: true });
  await runFfmpeg(
    [
      '-y',
      '-i',
      videoPath,
      '-vf',
      `fps=${sampleFps}`,
      '-frames:v',
      String(maxFrames),
      '-q:v',
      '2',
      join(framesDir, 'frame_%04d.jpg'),
    ],
    bins,
  );
  const entries = await readdir(framesDir);
  return entries
    .filter((f) => f.startsWith('frame_') && f.endsWith('.jpg'))
    .sort()
    .map((f) => join(framesDir, f));
}

export async function scoreSampledFrames(
  framePaths: string[],
  sampleFps: number,
  durationSec: number,
  options: HighlightSnapshotOptions,
): Promise<HighlightScoredFrame[]> {
  const t0 = durationSec * options.interiorStartRatio;
  const t1 = durationSec * options.interiorEndRatio;

  const rawFrames: Omit<
    HighlightScoredFrame,
    'compositeScore' | 'centerScore'
  >[] = [];

  let prevGray: Uint8Array | null = null;
  let prevW = 0;
  let prevH = 0;

  for (let i = 0; i < framePaths.length; i++) {
    const t = i / sampleFps;
    const framePath = framePaths[i];
    let person = null;
    try {
      person = await detectLargestPerson(
        framePath,
        options.modelPath,
        options.minConfidence,
      );
    } catch {
      person = null;
    }

    const sharpnessScore = await computeSharpnessScore(sharp, framePath);
    const thumb = await loadGrayscaleThumb(sharp, framePath);
    const motionScore = computeMotionScore(
      thumb.buffer,
      prevGray,
      person,
      thumb.width,
      thumb.height,
    );
    prevGray = thumb.buffer;
    prevW = thumb.width;
    prevH = thumb.height;

    rawFrames.push({
      t,
      framePath,
      person,
      personScore: person
        ? rawPersonScore(person, options.minPersonArea)
        : 0,
      motionScore,
      sharpnessScore,
      inInterior: t >= t0 && t <= t1,
    });
  }

  return applyCompositeScores(rawFrames, {
    weightPerson: options.weightPerson,
    weightMotion: options.weightMotion,
    weightSharpness: options.weightSharpness,
    weightCenter: options.weightCenter,
  });
}

export type VideoFrameAnalysisResult = {
  scoredFrames: HighlightScoredFrame[];
  framePaths: string[];
  sourceWidth: number;
  sourceHeight: number;
  durationSec: number;
};

export async function analyzeVideoFrames(
  videoPath: string,
  workDir: string,
  bins: FfmpegBinaries,
  options: HighlightSnapshotOptions,
): Promise<VideoFrameAnalysisResult> {
  const probe = await ffprobeJson(videoPath, bins);
  const framesDir = join(workDir, 'highlight-frames');
  const framePaths = await extractSampleFrames(
    videoPath,
    framesDir,
    options.sampleFps,
    options.maxSampleFrames,
    bins,
  );

  const scoredFrames =
    framePaths.length > 0 && options.enabled
      ? await scoreSampledFrames(
          framePaths,
          options.sampleFps,
          probe.durationSec,
          options,
        )
      : [];

  return {
    scoredFrames,
    framePaths,
    sourceWidth: probe.videoWidth,
    sourceHeight: probe.videoHeight,
    durationSec: probe.durationSec,
  };
}

export function highlightOptionsFromConfig(
  cfg: import('../config/video.config').VideoConfigValues,
): HighlightSnapshotOptions {
  return {
    enabled: cfg.highlightSnapshotsEnabled,
    sampleFps: cfg.highlightSampleFps,
    maxSampleFrames: cfg.highlightMaxSampleFrames,
    minPersonArea: cfg.highlightMinPersonArea,
    weightPerson: cfg.highlightWeightPerson,
    weightMotion: cfg.highlightWeightMotion,
    weightSharpness: cfg.highlightWeightSharpness,
    weightCenter: cfg.highlightWeightCenter,
    fallbackHitRate: cfg.highlightFallbackHitRate,
    minConfidence: cfg.socialTrackMinConfidence,
    modelPath: cfg.socialDetectorModelPath,
    interiorStartRatio: cfg.interiorStartRatio,
    interiorEndRatio: cfg.interiorEndRatio,
  };
}
