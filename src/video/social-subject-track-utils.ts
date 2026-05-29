import type { SubjectSample } from './social-subject.types';

export function smoothSubjectSamples(
  raw: SubjectSample[],
  alpha: number,
): SubjectSample[] {
  if (raw.length === 0) return [];
  const a = Math.min(1, Math.max(0.01, alpha));
  const out: SubjectSample[] = [];
  let cx = raw[0].cx;
  let cy = raw[0].cy;
  for (const sample of raw) {
    if (sample.confidence > 0) {
      cx = a * sample.cx + (1 - a) * cx;
      cy = a * sample.cy + (1 - a) * cy;
    }
    out.push({
      t: sample.t,
      cx,
      cy,
      confidence: sample.confidence,
    });
  }
  return out;
}

export function capPanSpeed(
  samples: SubjectSample[],
  maxPanNormPerSec: number,
): SubjectSample[] {
  if (samples.length <= 1 || maxPanNormPerSec <= 0) return samples;
  const out: SubjectSample[] = [{ ...samples[0] }];
  for (let i = 1; i < samples.length; i++) {
    const prev = out[i - 1];
    const cur = samples[i];
    const dt = Math.max(0.001, cur.t - prev.t);
    const maxDelta = maxPanNormPerSec * dt;
    const dx = cur.cx - prev.cx;
    const dy = cur.cy - prev.cy;
    const dist = Math.hypot(dx, dy);
    if (dist <= maxDelta) {
      out.push({ ...cur });
      continue;
    }
    const scale = maxDelta / dist;
    out.push({
      t: cur.t,
      cx: prev.cx + dx * scale,
      cy: prev.cy + dy * scale,
      confidence: cur.confidence,
    });
  }
  return out;
}

export function interpolateSubjectAt(
  samples: SubjectSample[],
  t: number,
): { cx: number; cy: number } {
  if (samples.length === 0) return { cx: 0.5, cy: 0.58 };
  if (t <= samples[0].t) return { cx: samples[0].cx, cy: samples[0].cy };
  const last = samples[samples.length - 1];
  if (t >= last.t) return { cx: last.cx, cy: last.cy };

  for (let i = 1; i < samples.length; i++) {
    const b = samples[i];
    const a = samples[i - 1];
    if (t > b.t) continue;
    const span = b.t - a.t;
    if (span <= 0) return { cx: b.cx, cy: b.cy };
    const u = (t - a.t) / span;
    return {
      cx: a.cx + (b.cx - a.cx) * u,
      cy: a.cy + (b.cy - a.cy) * u,
    };
  }
  return { cx: last.cx, cy: last.cy };
}

export function subsampleByCount<T>(items: T[], maxCount: number): T[] {
  if (items.length <= maxCount) return items;
  const out: T[] = [];
  for (let i = 0; i < maxCount; i++) {
    const idx = Math.round((i * (items.length - 1)) / (maxCount - 1));
    out.push(items[idx]);
  }
  return out;
}
