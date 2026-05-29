import {
  computeCoverCropGeometry,
  fallbackStaticCrop,
  planCropKeyframes,
  subjectToCropOrigin,
} from './social-crop-planner';
import type { SubjectSample } from './social-subject.types';

describe('social-crop-planner', () => {
  const samples: SubjectSample[] = [
    { t: 0, cx: 0.2, cy: 0.5, confidence: 0.9 },
    { t: 1, cx: 0.8, cy: 0.5, confidence: 0.9 },
  ];

  it('computes cover geometry for landscape to 9:16', () => {
    const geom = computeCoverCropGeometry(1920, 1080, 1080, 1920);
    expect(geom.scale).toBeCloseTo(1920 / 1080, 5);
    expect(geom.scaledWidth).toBeGreaterThan(1080);
    expect(geom.maxX).toBeGreaterThan(0);
  });

  it('centers crop on subject', () => {
    const geom = computeCoverCropGeometry(1920, 1080, 1080, 1920);
    const left = subjectToCropOrigin(0.2, 0.5, geom, 1080, 1920);
    const right = subjectToCropOrigin(0.8, 0.5, geom, 1080, 1920);
    expect(right.x).toBeGreaterThan(left.x);
  });

  it('plans keyframes across duration', () => {
    const keys = planCropKeyframes(
      samples,
      1920,
      1080,
      1080,
      1920,
      2,
      0.5,
      20,
    );
    expect(keys.length).toBeGreaterThan(1);
    expect(keys[0].t).toBe(0);
    expect(keys.at(-1)?.t).toBeLessThanOrEqual(2);
  });

  it('fallback uses lower-third Y bias', () => {
    const geom = computeCoverCropGeometry(1920, 1080, 1080, 1920);
    const center = subjectToCropOrigin(0.5, 0.5, geom, 1080, 1920);
    const lower = fallbackStaticCrop(1920, 1080, 1080, 1920, 0.58);
    expect(lower.y).toBeGreaterThanOrEqual(center.y);
  });
});
