import type { PersonDetection } from './social-subject-detector';

export type HighlightScoredFrame = {
  t: number;
  framePath: string;
  person: PersonDetection | null;
  personScore: number;
  motionScore: number;
  sharpnessScore: number;
  centerScore: number;
  compositeScore: number;
  inInterior: boolean;
};

export type HighlightSnapshotOptions = {
  enabled: boolean;
  sampleFps: number;
  maxSampleFrames: number;
  minPersonArea: number;
  weightPerson: number;
  weightMotion: number;
  weightSharpness: number;
  weightCenter: number;
  fallbackHitRate: number;
  minConfidence: number;
  modelPath: string;
  interiorStartRatio: number;
  interiorEndRatio: number;
};

export type HighlightSnapshotResult = {
  method: 'tier2' | 'even';
  detectionHitRate: number;
  selections: HighlightScoredFrame[];
};
