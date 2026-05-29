/** Normalized subject center in source video coordinates (0–1). */
export type SubjectSample = {
  t: number;
  cx: number;
  cy: number;
  confidence: number;
};

export type SubjectTrack = {
  samples: SubjectSample[];
  /** Fraction of sampled frames with a person detection. */
  detectionHitRate: number;
  sourceWidth: number;
  sourceHeight: number;
  durationSec: number;
};

export type CropKeyframe = {
  t: number;
  x: number;
  y: number;
};

export type SubjectTrackAnalysis = {
  track: SubjectTrack | null;
  sampleCount: number;
  detectionHitRate: number;
  sourceWidth: number;
  sourceHeight: number;
  durationSec: number;
};

export type SmartCropOptions = {
  enabled: boolean;
  sampleFps: number;
  maxSampleFrames: number;
  smoothing: number;
  minConfidence: number;
  maxPanPxPerSec: number;
  fallbackCenterY: number;
  sendcmdIntervalSec: number;
  modelPath: string;
};
