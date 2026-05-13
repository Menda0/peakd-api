/** Stored on SurfSession.waveTypes; keep in sync with frontend `lib/surf-session-waves.ts`. */
export const WAVE_TYPE_IDS = [
  'mushy',
  'clean',
  'closeouts',
  'barreling',
  'big_wave',
] as const;

export type WaveTypeId = (typeof WAVE_TYPE_IDS)[number];

export const WAVE_TYPE_ID_SET = new Set<string>(WAVE_TYPE_IDS);
