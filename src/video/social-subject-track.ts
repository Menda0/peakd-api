import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FfmpegBinaries } from '../ffmpeg/ffmpeg.helper';
import { ffprobeJson } from '../ffmpeg/ffmpeg.helper';
import { detectLargestPerson } from './social-subject-detector';
import { extractSampleFrames } from './video-frame-analysis';
import {
  capPanSpeed,
  smoothSubjectSamples,
} from './social-subject-track-utils';
import type {
  SmartCropOptions,
  SubjectSample,
  SubjectTrack,
  SubjectTrackAnalysis,
} from './social-subject.types';

export { extractSampleFrames } from './video-frame-analysis';

export async function analyzeSubjectTrack(
  videoPath: string,
  workDir: string,
  bins: FfmpegBinaries,
  options: SmartCropOptions,
): Promise<SubjectTrackAnalysis> {
  if (!options.enabled) {
    const probe = await ffprobeJson(videoPath, bins);
    return {
      track: null,
      sampleCount: 0,
      detectionHitRate: 0,
      sourceWidth: probe.videoWidth,
      sourceHeight: probe.videoHeight,
      durationSec: probe.durationSec,
    };
  }

  const probe = await ffprobeJson(videoPath, bins);
  const sourceWidth = probe.videoWidth;
  const sourceHeight = probe.videoHeight;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return {
      track: null,
      sampleCount: 0,
      detectionHitRate: 0,
      sourceWidth: 0,
      sourceHeight: 0,
      durationSec: probe.durationSec,
    };
  }

  const framesDir = join(workDir, 'subject-frames');
  let framePaths: string[] = [];
  try {
    framePaths = await extractSampleFrames(
      videoPath,
      framesDir,
      options.sampleFps,
      options.maxSampleFrames,
      bins,
    );
  } catch {
    return {
      track: null,
      sampleCount: 0,
      detectionHitRate: 0,
      sourceWidth,
      sourceHeight,
      durationSec: probe.durationSec,
    };
  }

  const rawSamples: SubjectSample[] = [];
  let hits = 0;
  for (let i = 0; i < framePaths.length; i++) {
    const t = i / options.sampleFps;
    try {
      const person = await detectLargestPerson(
        framePaths[i],
        options.modelPath,
        options.minConfidence,
      );
      if (person) {
        hits += 1;
        rawSamples.push({
          t,
          cx: person.cx,
          cy: person.cy,
          confidence: person.confidence,
        });
      } else {
        rawSamples.push({ t, cx: 0.5, cy: options.fallbackCenterY, confidence: 0 });
      }
    } catch {
      rawSamples.push({ t, cx: 0.5, cy: options.fallbackCenterY, confidence: 0 });
    }
  }

  await rm(framesDir, { recursive: true, force: true }).catch(() => undefined);

  const sampleCount = rawSamples.length;
  const detectionHitRate = sampleCount > 0 ? hits / sampleCount : 0;

  if (hits === 0) {
    return {
      track: null,
      sampleCount,
      detectionHitRate: 0,
      sourceWidth,
      sourceHeight,
      durationSec: probe.durationSec,
    };
  }

  const maxPanNormPerSec =
    options.maxPanPxPerSec /
    Math.max(sourceWidth, sourceHeight);
  const smoothed = smoothSubjectSamples(rawSamples, options.smoothing);
  const capped = capPanSpeed(smoothed, maxPanNormPerSec);

  const track: SubjectTrack = {
    samples: capped,
    detectionHitRate,
    sourceWidth,
    sourceHeight,
    durationSec: probe.durationSec,
  };

  return {
    track,
    sampleCount,
    detectionHitRate,
    sourceWidth,
    sourceHeight,
    durationSec: probe.durationSec,
  };
}

export function smartCropOptionsFromConfig(
  cfg: import('../config/video.config').VideoConfigValues,
): SmartCropOptions {
  return {
    enabled: cfg.socialSmartCropEnabled,
    sampleFps: cfg.socialTrackSampleFps,
    maxSampleFrames: cfg.socialTrackMaxSampleFrames,
    smoothing: cfg.socialTrackSmoothing,
    minConfidence: cfg.socialTrackMinConfidence,
    maxPanPxPerSec: cfg.socialTrackMaxPanPxPerSec,
    fallbackCenterY: cfg.socialTrackFallbackCenterY,
    sendcmdIntervalSec: cfg.socialTrackSendcmdIntervalSec,
    modelPath: cfg.socialDetectorModelPath,
  };
}
