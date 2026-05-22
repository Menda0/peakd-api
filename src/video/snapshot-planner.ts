export interface SnapshotPlannerOptions {
  /** Ratio of duration for first usable time (exclusive of true start). Default 0.08 */
  interiorStartRatio: number;
  /** Ratio of duration for last usable time (exclusive of true end). Default 0.92 */
  interiorEndRatio: number;
  /** Minimum snapshot count (default 5) */
  snapshotMinFrames: number;
  /** Maximum snapshot count (default 10) */
  snapshotMaxFrames: number;
  /** At this duration or less, use `snapshotMinFrames` */
  snapshotScaleShortSec: number;
  /** At this duration or more, use `snapshotMaxFrames` */
  snapshotScaleLongSec: number;
}

/**
 * Snapshot count scales with duration between min and max (inclusive).
 * Below short threshold → min; at or above long threshold → max; linear in between.
 */
export function resolveSnapshotFrameCount(
  durationSec: number,
  opts: Pick<
    SnapshotPlannerOptions,
    | 'snapshotMinFrames'
    | 'snapshotMaxFrames'
    | 'snapshotScaleShortSec'
    | 'snapshotScaleLongSec'
  >,
): number {
  const {
    snapshotMinFrames: minF,
    snapshotMaxFrames: maxF,
    snapshotScaleShortSec: shortS,
    snapshotScaleLongSec: longS,
  } = opts;

  if (durationSec <= shortS) {
    return minF;
  }
  if (durationSec >= longS) {
    return maxF;
  }
  const t = (durationSec - shortS) / (longS - shortS);
  const raw = minF + t * (maxF - minF);
  return Math.min(maxF, Math.max(minF, Math.round(raw)));
}

/**
 * Chooses snapshot timestamps strictly inside the interior window,
 * evenly spaced, never at the very beginning or end of the file.
 *
 * Frame count: between `snapshotMinFrames` and `snapshotMaxFrames`, scaling with
 * duration from `snapshotScaleShortSec` to `snapshotScaleLongSec`.
 */
export function planSnapshotTimes(
  durationSec: number,
  opts: SnapshotPlannerOptions,
): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('durationSec must be a positive finite number');
  }

  const {
    interiorStartRatio,
    interiorEndRatio,
    snapshotMinFrames,
    snapshotMaxFrames,
    snapshotScaleShortSec,
    snapshotScaleLongSec,
  } = opts;

  if (
    !Number.isFinite(interiorStartRatio) ||
    !Number.isFinite(interiorEndRatio) ||
    interiorStartRatio >= interiorEndRatio ||
    interiorStartRatio < 0 ||
    interiorEndRatio > 1
  ) {
    throw new Error('invalid interior ratios');
  }

  if (
    !Number.isFinite(snapshotMinFrames) ||
    !Number.isFinite(snapshotMaxFrames) ||
    snapshotMinFrames < 1 ||
    snapshotMaxFrames > 50 ||
    snapshotMinFrames > snapshotMaxFrames
  ) {
    throw new Error(
      'snapshotMinFrames and snapshotMaxFrames must be valid with min <= max',
    );
  }

  if (
    !Number.isFinite(snapshotScaleShortSec) ||
    !Number.isFinite(snapshotScaleLongSec) ||
    snapshotScaleShortSec <= 0 ||
    snapshotScaleLongSec <= snapshotScaleShortSec
  ) {
    throw new Error(
      'snapshotScaleShortSec and snapshotScaleLongSec must be positive with short < long',
    );
  }

  const t0 = durationSec * interiorStartRatio;
  const t1 = durationSec * interiorEndRatio;
  const span = t1 - t0;
  if (span <= 0) {
    throw new Error('interior window is empty for this duration');
  }

  const count = resolveSnapshotFrameCount(durationSec, {
    snapshotMinFrames,
    snapshotMaxFrames,
    snapshotScaleShortSec,
    snapshotScaleLongSec,
  });

  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = t0 + ((i + 1) * span) / (count + 1);
    times.push(t);
  }

  return times;
}
