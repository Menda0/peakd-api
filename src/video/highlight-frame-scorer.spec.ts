import {
  applyCompositeScores,
  centerCompositionScore,
  normalizeSignal,
  rawPersonScore,
} from './highlight-frame-scorer';
import type { PersonDetection } from './social-subject-detector';

function person(overrides: Partial<PersonDetection> = {}): PersonDetection {
  return {
    cx: 0.5,
    cy: 0.5,
    width: 0.2,
    height: 0.4,
    confidence: 0.9,
    ...overrides,
  };
}

describe('centerCompositionScore', () => {
  it('peaks at frame center', () => {
    expect(centerCompositionScore(0.5, 0.5)).toBe(1);
  });

  it('decreases toward corners', () => {
    expect(centerCompositionScore(0, 0)).toBeLessThan(
      centerCompositionScore(0.4, 0.5),
    );
  });
});

describe('rawPersonScore', () => {
  it('returns zero when bbox area is below minimum', () => {
    expect(rawPersonScore(person({ width: 0.02, height: 0.02 }), 0.008)).toBe(0);
  });

  it('applies edge penalty when subject hugs frame border', () => {
    const centered = rawPersonScore(person(), 0.008);
    const edge = rawPersonScore(person({ cx: 0.02, cy: 0.5 }), 0.008);
    expect(edge).toBeLessThan(centered);
  });
});

describe('normalizeSignal', () => {
  it('maps values to 0–1 range', () => {
    expect(normalizeSignal([0, 5, 10])).toEqual([0, 0.5, 1]);
  });

  it('returns uniform 1 when all values equal and positive', () => {
    expect(normalizeSignal([3, 3, 3])).toEqual([1, 1, 1]);
  });
});

describe('applyCompositeScores', () => {
  it('weights person signal into composite score', () => {
    const frames = applyCompositeScores(
      [
        {
          t: 0,
          framePath: '/a.jpg',
          person: person(),
          personScore: 10,
          motionScore: 0,
          sharpnessScore: 0,
          inInterior: true,
        },
        {
          t: 1,
          framePath: '/b.jpg',
          person: null,
          personScore: 0,
          motionScore: 0,
          sharpnessScore: 0,
          inInterior: true,
        },
      ],
      {
        weightPerson: 1,
        weightMotion: 0,
        weightSharpness: 0,
        weightCenter: 0,
      },
    );

    expect(frames[0].compositeScore).toBe(1);
    expect(frames[1].compositeScore).toBe(0);
    expect(frames[0].centerScore).toBe(1);
    expect(frames[1].centerScore).toBe(0);
  });
});
