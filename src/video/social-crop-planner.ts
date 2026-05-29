import { clamp } from './social-math';
import type { CropKeyframe, SubjectSample } from './social-subject.types';
import {
  interpolateSubjectAt,
  subsampleByCount,
} from './social-subject-track-utils';

export type CoverCropGeometry = {
  scale: number;
  scaledWidth: number;
  scaledHeight: number;
  maxX: number;
  maxY: number;
};

export function computeCoverCropGeometry(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): CoverCropGeometry {
  const scale = Math.max(
    targetWidth / sourceWidth,
    targetHeight / sourceHeight,
  );
  const scaledWidth = sourceWidth * scale;
  const scaledHeight = sourceHeight * scale;
  return {
    scale,
    scaledWidth,
    scaledHeight,
    maxX: Math.max(0, scaledWidth - targetWidth),
    maxY: Math.max(0, scaledHeight - targetHeight),
  };
}

export function subjectToCropOrigin(
  cxNorm: number,
  cyNorm: number,
  geom: CoverCropGeometry,
  targetWidth: number,
  targetHeight: number,
): { x: number; y: number } {
  const cx = cxNorm * geom.scaledWidth;
  const cy = cyNorm * geom.scaledHeight;
  return {
    x: clamp(cx - targetWidth / 2, 0, geom.maxX),
    y: clamp(cy - targetHeight / 2, 0, geom.maxY),
  };
}

export function planCropKeyframes(
  samples: SubjectSample[],
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  durationSec: number,
  sendcmdIntervalSec: number,
  maxKeyframes: number,
): CropKeyframe[] {
  const geom = computeCoverCropGeometry(
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
  );
  const interval = Math.max(0.05, sendcmdIntervalSec);
  const count = Math.max(2, Math.ceil(durationSec / interval) + 1);
  const raw: CropKeyframe[] = [];
  for (let i = 0; i < count; i++) {
    const t = Math.min(durationSec, i * interval);
    const { cx, cy } = interpolateSubjectAt(samples, t);
    const { x, y } = subjectToCropOrigin(
      cx,
      cy,
      geom,
      targetWidth,
      targetHeight,
    );
    raw.push({ t, x, y });
  }
  return subsampleByCount(raw, maxKeyframes);
}

export function fallbackStaticCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  fallbackCenterY: number,
): { x: number; y: number } {
  const geom = computeCoverCropGeometry(
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
  );
  return subjectToCropOrigin(0.5, fallbackCenterY, geom, targetWidth, targetHeight);
}

export function buildCropTimeExpression(
  keyframes: CropKeyframe[],
  axis: 'x' | 'y',
  maxSegments = 80,
): string {
  if (keyframes.length === 0) return '0';
  const sampled = subsampleByCount(keyframes, maxSegments);
  if (sampled.length === 1) {
    return String(Math.round(sampled[0][axis]));
  }

  let expr = String(Math.round(sampled[sampled.length - 1][axis]));
  for (let i = sampled.length - 2; i >= 0; i--) {
    const a = sampled[i];
    const b = sampled[i + 1];
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    const av = a[axis];
    const bv = b[axis];
    const slope = (bv - av) / dt;
    expr = `if(lt(t\\,${b.t.toFixed(3)})\\,${av.toFixed(2)}+(t-${a.t.toFixed(3)})*${slope.toFixed(4)}\\,${expr})`;
  }
  return expr;
}
