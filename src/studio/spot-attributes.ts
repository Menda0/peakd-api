import { BadRequestException } from '@nestjs/common';

export const SPOT_LEVEL_OPTIONS = [
  { id: 'beginner', label: 'Beginner' },
  { id: 'intermediate', label: 'Intermediate' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'expert', label: 'Expert' },
] as const;

export type SpotLevelId = (typeof SPOT_LEVEL_OPTIONS)[number]['id'];

const LEVEL_ORDER: SpotLevelId[] = SPOT_LEVEL_OPTIONS.map((o) => o.id);

const LEVEL_LABEL_BY_ID = Object.fromEntries(
  SPOT_LEVEL_OPTIONS.map((o) => [o.id, o.label]),
) as Record<SpotLevelId, string>;

const COMPOSITE_LEVEL_MAP: Record<string, SpotLevelId[]> = {
  Beginner: ['beginner'],
  Intermediate: ['intermediate'],
  Advanced: ['advanced'],
  'Expert Only': ['expert'],
  'Beginner–Intermediate': ['beginner', 'intermediate'],
  'Beginner–Advanced': ['beginner', 'advanced'],
  'Intermediate–Advanced': ['intermediate', 'advanced'],
  'Advanced–Expert': ['advanced', 'expert'],
};

export const SPOT_BREAK_TYPE_OPTIONS = [
  'Beach break',
  'Reef break',
  'Point break',
  'Rivermouth',
  'Rivermouth / Beach',
  'Rivermouth / Beach break',
  'Sandbar',
  'Sandbar / Rivermouth',
  'Sandbar Beach break',
  'Reef / Beach',
  'Reef / Point',
  'Point / Reef',
  'Point / Rivermouth',
  'Protected Beach break',
  'Sheltered Beach break',
  'Hollow Beach break',
  'Powerful Beach break',
  'Heavy Reef',
  'Slab / Reef',
  'Canyon Big Wave',
] as const;

export type SpotBreakType = (typeof SPOT_BREAK_TYPE_OPTIONS)[number];

export const SPOT_CONSISTENCY_OPTIONS = [
  'Very High',
  'High',
  'Medium–High',
  'Medium',
  'Low–Medium',
] as const;

export type SpotConsistency = (typeof SPOT_CONSISTENCY_OPTIONS)[number];

function labelToLevelId(part: string): SpotLevelId | null {
  const n = part.trim().toLowerCase();
  if (!n) return null;
  if (n === 'expert only' || n === 'expert') return 'expert';
  if (n === 'beginner') return 'beginner';
  if (n === 'intermediate') return 'intermediate';
  if (n === 'advanced') return 'advanced';
  return null;
}

export function parseSpotLevels(raw: string | null | undefined): SpotLevelId[] {
  if (!raw?.trim()) return [];
  const trimmed = raw.trim();
  const composite = COMPOSITE_LEVEL_MAP[trimmed];
  if (composite) return [...composite];

  const ids: SpotLevelId[] = [];
  for (const part of trimmed.split(/\s*[–,\/]\s*/)) {
    const id = labelToLevelId(part);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return LEVEL_ORDER.filter((id) => ids.includes(id));
}

export function formatSpotLevels(levels: SpotLevelId[]): string | null {
  if (levels.length === 0) return null;
  const ordered = LEVEL_ORDER.filter((id) => levels.includes(id));
  return ordered.map((id) => LEVEL_LABEL_BY_ID[id]).join('–');
}

function isSpotBreakType(value: string): value is SpotBreakType {
  return (SPOT_BREAK_TYPE_OPTIONS as readonly string[]).includes(value);
}

function isSpotConsistency(value: string): value is SpotConsistency {
  return (SPOT_CONSISTENCY_OPTIONS as readonly string[]).includes(value);
}

export function normalizeSpotLevel(
  input: string | null | undefined,
): string | null {
  if (input === undefined || input === null) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  const parsed = parseSpotLevels(trimmed);
  if (parsed.length === 0) {
    throw new BadRequestException('Invalid spot level');
  }
  return formatSpotLevels(parsed);
}

export function normalizeSpotBreakType(
  input: string | null | undefined,
): string | null {
  if (input === undefined || input === null) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  if (!isSpotBreakType(trimmed)) {
    throw new BadRequestException('Invalid break type');
  }
  return trimmed;
}

export function normalizeSpotConsistency(
  input: string | null | undefined,
): string | null {
  if (input === undefined || input === null) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  if (!isSpotConsistency(trimmed)) {
    throw new BadRequestException('Invalid consistency');
  }
  return trimmed;
}
