import {
  planSnapshotTimes,
  resolveSnapshotFrameCount,
  type SnapshotPlannerOptions,
} from './snapshot-planner';
import type {
  HighlightScoredFrame,
  HighlightSnapshotOptions,
  HighlightSnapshotResult,
} from './highlight.types';

function interiorBounds(
  durationSec: number,
  startRatio: number,
  endRatio: number,
): { t0: number; t1: number } {
  return {
    t0: durationSec * startRatio,
    t1: durationSec * endRatio,
  };
}

function nearestFrame(
  frames: HighlightScoredFrame[],
  t: number,
): HighlightScoredFrame | null {
  if (frames.length === 0) return null;
  let best = frames[0];
  let bestDist = Math.abs(frames[0].t - t);
  for (let i = 1; i < frames.length; i++) {
    const dist = Math.abs(frames[i].t - t);
    if (dist < bestDist) {
      bestDist = dist;
      best = frames[i];
    }
  }
  return best;
}

export function planHighlightSnapshots(
  scoredFrames: HighlightScoredFrame[],
  durationSec: number,
  snapshotOpts: SnapshotPlannerOptions,
  highlightOpts: HighlightSnapshotOptions,
): HighlightSnapshotResult {
  const evenTimes = planSnapshotTimes(durationSec, snapshotOpts);
  const detectionHitRate =
    scoredFrames.length > 0
      ? scoredFrames.filter((f) => f.person !== null).length / scoredFrames.length
      : 0;

  if (
    !highlightOpts.enabled ||
    scoredFrames.length === 0 ||
    detectionHitRate < highlightOpts.fallbackHitRate
  ) {
    const selections = evenTimes
      .map((t) => nearestFrame(scoredFrames, t))
      .filter((f): f is HighlightScoredFrame => f !== null);
    if (selections.length < evenTimes.length) {
      return {
        method: 'even',
        detectionHitRate,
        selections: evenTimes.map((t, i) =>
          nearestFrame(scoredFrames, t) ?? {
            t,
            framePath: '',
            person: null,
            personScore: 0,
            motionScore: 0,
            sharpnessScore: 0,
            centerScore: 0,
            compositeScore: 0,
            inInterior: true,
          },
        ),
      };
    }
    return {
      method: 'even',
      detectionHitRate,
      selections: evenTimes.map((t, i) => ({
        ...selections[i],
        t,
      })),
    };
  }

  const count = resolveSnapshotFrameCount(durationSec, snapshotOpts);
  const { t0, t1 } = interiorBounds(
    durationSec,
    highlightOpts.interiorStartRatio,
    highlightOpts.interiorEndRatio,
  );
  const span = t1 - t0;
  const interiorFrames = scoredFrames.filter((f) => f.inInterior);

  const selections: HighlightScoredFrame[] = [];
  let windowsWithPerson = 0;

  for (let i = 0; i < count; i++) {
    const winStart = t0 + (i * span) / count;
    const winEnd = t0 + ((i + 1) * span) / count;
    const winMid = (winStart + winEnd) / 2;
    const inWindow = interiorFrames.filter(
      (f) => f.t >= winStart && f.t < winEnd,
    );
    const pool = inWindow.length > 0 ? inWindow : interiorFrames;

    if (pool.length === 0) {
      selections.push({
        t: winMid,
        framePath: '',
        person: null,
        personScore: 0,
        motionScore: 0,
        sharpnessScore: 0,
        centerScore: 0,
        compositeScore: 0,
        inInterior: true,
      });
      continue;
    }

    const best = pool.reduce((a, b) =>
      b.compositeScore > a.compositeScore ? b : a,
    );
    if (best.person) windowsWithPerson += 1;
    selections.push({ ...best, t: best.t });
  }

  if (windowsWithPerson / count < highlightOpts.fallbackHitRate) {
    return {
      method: 'even',
      detectionHitRate,
      selections: evenTimes.map((t) => {
        const frame = nearestFrame(scoredFrames, t);
        return (
          frame ?? {
            t,
            framePath: '',
            person: null,
            personScore: 0,
            motionScore: 0,
            sharpnessScore: 0,
            centerScore: 0,
            compositeScore: 0,
            inInterior: true,
          }
        );
      }),
    };
  }

  selections.sort((a, b) => a.t - b.t);
  return {
    method: 'tier2',
    detectionHitRate,
    selections,
  };
}
