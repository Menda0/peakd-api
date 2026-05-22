import {
  planSnapshotTimes,
  resolveSnapshotFrameCount,
} from './snapshot-planner';

const defaults = {
  interiorStartRatio: 0.08,
  interiorEndRatio: 0.92,
  snapshotMinFrames: 5,
  snapshotMaxFrames: 10,
  snapshotScaleShortSec: 20,
  snapshotScaleLongSec: 120,
};

describe('resolveSnapshotFrameCount', () => {
  it('uses min frames at or below short scale duration', () => {
    expect(resolveSnapshotFrameCount(5, defaults)).toBe(5);
    expect(resolveSnapshotFrameCount(20, defaults)).toBe(5);
  });

  it('uses max frames at or above long scale duration', () => {
    expect(resolveSnapshotFrameCount(120, defaults)).toBe(10);
    expect(resolveSnapshotFrameCount(300, defaults)).toBe(10);
  });

  it('interpolates between short and long thresholds', () => {
    expect(resolveSnapshotFrameCount(70, defaults)).toBe(8);
  });
});

describe('planSnapshotTimes', () => {
  it('places 5 evenly spaced times inside the interior for a short video', () => {
    const times = planSnapshotTimes(15, defaults);
    expect(times).toHaveLength(5);
    const t0 = 15 * 0.08;
    const t1 = 15 * 0.92;
    const span = t1 - t0;
    for (let i = 0; i < 5; i++) {
      expect(times[i]).toBeCloseTo(t0 + ((i + 1) * span) / 6, 10);
      expect(times[i]).toBeGreaterThan(t0);
      expect(times[i]).toBeLessThan(t1);
    }
  });

  it('uses max frames for long videos', () => {
    const times = planSnapshotTimes(150, defaults);
    expect(times).toHaveLength(10);
    const t0 = 150 * 0.08;
    const t1 = 150 * 0.92;
    const span = t1 - t0;
    for (let i = 0; i < 10; i++) {
      expect(times[i]).toBeCloseTo(t0 + ((i + 1) * span) / 11, 10);
    }
  });

  it('rejects non-positive duration', () => {
    expect(() => planSnapshotTimes(0, defaults)).toThrow();
    expect(() => planSnapshotTimes(-1, defaults)).toThrow();
  });
});
