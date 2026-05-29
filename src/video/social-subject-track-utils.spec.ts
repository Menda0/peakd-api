import {
  capPanSpeed,
  interpolateSubjectAt,
  smoothSubjectSamples,
} from './social-subject-track-utils';
import type { SubjectSample } from './social-subject.types';

describe('social-subject-track-utils', () => {
  it('smooths subject positions with EMA', () => {
    const raw: SubjectSample[] = [
      { t: 0, cx: 0, cy: 0.5, confidence: 1 },
      { t: 1, cx: 1, cy: 0.5, confidence: 1 },
    ];
    const smoothed = smoothSubjectSamples(raw, 0.5);
    expect(smoothed[1].cx).toBeGreaterThan(0);
    expect(smoothed[1].cx).toBeLessThan(1);
  });

  it('caps pan speed between samples', () => {
    const raw: SubjectSample[] = [
      { t: 0, cx: 0, cy: 0.5, confidence: 1 },
      { t: 1, cx: 1, cy: 0.5, confidence: 1 },
    ];
    const capped = capPanSpeed(raw, 0.2);
    expect(capped[1].cx).toBeLessThan(1);
    expect(capped[1].cx).toBeCloseTo(0.2, 5);
  });

  it('interpolates subject position at arbitrary time', () => {
    const samples: SubjectSample[] = [
      { t: 0, cx: 0, cy: 0, confidence: 1 },
      { t: 2, cx: 1, cy: 1, confidence: 1 },
    ];
    const mid = interpolateSubjectAt(samples, 1);
    expect(mid.cx).toBeCloseTo(0.5, 5);
    expect(mid.cy).toBeCloseTo(0.5, 5);
  });
});
