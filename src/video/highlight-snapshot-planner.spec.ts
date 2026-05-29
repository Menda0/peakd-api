import { planHighlightSnapshots } from './highlight-snapshot-planner';
import { planSnapshotTimes } from './snapshot-planner';
import type { HighlightScoredFrame, HighlightSnapshotOptions } from './highlight.types';

const snapshotOpts = {
  interiorStartRatio: 0.08,
  interiorEndRatio: 0.92,
  snapshotMinFrames: 5,
  snapshotMaxFrames: 10,
  snapshotScaleShortSec: 20,
  snapshotScaleLongSec: 120,
};

const highlightOpts: HighlightSnapshotOptions = {
  enabled: true,
  sampleFps: 4,
  maxSampleFrames: 120,
  minPersonArea: 0.008,
  weightPerson: 0.4,
  weightMotion: 0.35,
  weightSharpness: 0.15,
  weightCenter: 0.1,
  fallbackHitRate: 0.5,
  minConfidence: 0.35,
  modelPath: '/tmp/yolov8n.onnx',
  interiorStartRatio: 0.08,
  interiorEndRatio: 0.92,
};

function frame(
  t: number,
  compositeScore: number,
  withPerson = true,
): HighlightScoredFrame {
  return {
    t,
    framePath: `/frames/frame_${t}.jpg`,
    person: withPerson
      ? {
          cx: 0.5,
          cy: 0.5,
          width: 0.2,
          height: 0.4,
          confidence: 0.9,
        }
      : null,
    personScore: withPerson ? 1 : 0,
    motionScore: compositeScore,
    sharpnessScore: compositeScore,
    centerScore: withPerson ? 1 : 0,
    compositeScore,
    inInterior: true,
  };
}

describe('planHighlightSnapshots', () => {
  it('picks highest composite frame within each window for tier2', () => {
    const durationSec = 20;
    const scoredFrames = [
      frame(2, 0.2),
      frame(3, 0.9),
      frame(6, 0.3),
      frame(7, 0.95),
      frame(10, 0.4),
      frame(11, 0.85),
      frame(14, 0.25),
      frame(15, 0.8),
      frame(17, 0.35),
      frame(18, 0.75),
    ];

    const result = planHighlightSnapshots(
      scoredFrames,
      durationSec,
      snapshotOpts,
      highlightOpts,
    );

    expect(result.method).toBe('tier2');
    expect(result.selections).toHaveLength(5);
    expect(result.selections.map((s) => s.compositeScore)).toEqual(
      expect.arrayContaining([0.9, 0.95, 0.85, 0.8, 0.75]),
    );
    expect(result.selections.map((s) => s.t)).toEqual(
      [...result.selections.map((s) => s.t)].sort((a, b) => a - b),
    );
  });

  it('falls back to even spacing when detection hit rate is low', () => {
    const durationSec = 20;
    const scoredFrames = [
      frame(2, 0.9, true),
      frame(4, 0.1, false),
      frame(6, 0.1, false),
      frame(8, 0.1, false),
      frame(10, 0.1, false),
    ];

    const result = planHighlightSnapshots(
      scoredFrames,
      durationSec,
      snapshotOpts,
      highlightOpts,
    );

    expect(result.method).toBe('even');
    expect(result.selections).toHaveLength(5);
    const evenTimes = planSnapshotTimes(durationSec, snapshotOpts);
    for (let i = 0; i < evenTimes.length; i++) {
      expect(result.selections[i].t).toBe(evenTimes[i]);
    }
  });

  it('scales selection count to 10 for long clips', () => {
    const durationSec = 150;
    const scoredFrames = Array.from({ length: 40 }, (_, i) =>
      frame(i * 3 + 2, 0.5 + (i % 5) * 0.05, i % 2 === 0),
    );

    const result = planHighlightSnapshots(
      scoredFrames,
      durationSec,
      snapshotOpts,
      highlightOpts,
    );

    expect(result.selections).toHaveLength(10);
  });

  it('uses legacy planner when highlights disabled', () => {
    const durationSec = 20;
    const scoredFrames = [frame(5, 0.99)];

    const result = planHighlightSnapshots(
      scoredFrames,
      durationSec,
      snapshotOpts,
      { ...highlightOpts, enabled: false },
    );

    expect(result.method).toBe('even');
    expect(result.selections).toHaveLength(5);
  });
});
