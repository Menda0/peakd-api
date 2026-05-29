import { clamp } from './social-math';
import type { PersonDetection } from './social-subject-detector';
import type { HighlightScoredFrame } from './highlight.types';

export type HighlightScoreWeights = {
  weightPerson: number;
  weightMotion: number;
  weightSharpness: number;
  weightCenter: number;
};

export function centerCompositionScore(cx: number, cy: number): number {
  const dist = Math.hypot(cx - 0.5, cy - 0.5);
  return clamp(1 - dist * 2, 0, 1);
}

export function rawPersonScore(
  person: PersonDetection,
  minPersonArea: number,
): number {
  const area = person.width * person.height;
  if (area < minPersonArea) return 0;
  const center = centerCompositionScore(person.cx, person.cy);
  const edgePenalty =
    person.cx < 0.08 ||
    person.cx > 0.92 ||
    person.cy < 0.08 ||
    person.cy > 0.92
      ? 0.5
      : 1;
  return person.confidence * area * center * edgePenalty;
}

export function normalizeSignal(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max <= min) return values.map(() => (max > 0 ? 1 : 0));
  return values.map((v) => (v - min) / (max - min));
}

export function applyCompositeScores(
  frames: Omit<
    HighlightScoredFrame,
    'compositeScore' | 'centerScore'
  >[],
  weights: HighlightScoreWeights,
): HighlightScoredFrame[] {
  const personNorm = normalizeSignal(frames.map((f) => f.personScore));
  const motionNorm = normalizeSignal(frames.map((f) => f.motionScore));
  const sharpNorm = normalizeSignal(frames.map((f) => f.sharpnessScore));
  const centerNorm = frames.map((f) =>
    f.person ? centerCompositionScore(f.person.cx, f.person.cy) : 0,
  );

  const totalWeight =
    weights.weightPerson +
    weights.weightMotion +
    weights.weightSharpness +
    weights.weightCenter;
  const denom = totalWeight > 0 ? totalWeight : 1;

  return frames.map((frame, i) => ({
    ...frame,
    centerScore: centerNorm[i],
    compositeScore:
      (weights.weightPerson * personNorm[i] +
        weights.weightMotion * motionNorm[i] +
        weights.weightSharpness * sharpNorm[i] +
        weights.weightCenter * centerNorm[i]) /
      denom,
  }));
}

export function computeMotionScore(
  current: Uint8Array,
  previous: Uint8Array | null,
  person: PersonDetection | null,
  width: number,
  height: number,
): number {
  if (!previous || previous.length !== current.length) return 0;

  let sum = 0;
  let count = 0;

  if (person) {
    const x0 = Math.floor(clamp(person.cx - person.width / 2, 0, 1) * width);
    const x1 = Math.ceil(clamp(person.cx + person.width / 2, 0, 1) * width);
    const y0 = Math.floor(clamp(person.cy - person.height / 2, 0, 1) * height);
    const y1 = Math.ceil(clamp(person.cy + person.height / 2, 0, 1) * height);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = y * width + x;
        sum += Math.abs(current[idx] - previous[idx]);
        count += 1;
      }
    }
  } else {
    for (let i = 0; i < current.length; i++) {
      sum += Math.abs(current[i] - previous[i]);
      count += 1;
    }
  }

  if (count === 0) return 0;
  return sum / count / 255;
}

const LAPLACIAN_3X3 = {
  width: 3,
  height: 3,
  kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1],
};

export async function computeSharpnessScore(
  sharpMod: typeof import('sharp'),
  imagePath: string,
): Promise<number> {
  const { data, info } = await sharpMod(imagePath)
    .grayscale()
    .resize(320, 180, { fit: 'inside' })
    .convolve(LAPLACIAN_3X3)
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (!info.width || !info.height) return 0;
  let sumSq = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] - 128;
    sumSq += v * v;
  }
  return sumSq / data.length;
}

export async function loadGrayscaleThumb(
  sharpMod: typeof import('sharp'),
  imagePath: string,
): Promise<{ buffer: Uint8Array; width: number; height: number }> {
  const { data, info } = await sharpMod(imagePath)
    .grayscale()
    .resize(160, 90, { fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    buffer: new Uint8Array(data),
    width: info.width ?? 0,
    height: info.height ?? 0,
  };
}
