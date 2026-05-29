import {
  handleCandidatesFromBase,
  isReservedHandle,
  normalizeHandleInput,
  sanitizeEmailLocalPartToHandleBase,
} from './handle.utils';

describe('normalizeHandleInput', () => {
  it('lowercases and strips @ prefix', () => {
    expect(normalizeHandleInput('@John_Doe')).toBe('john_doe');
  });
});

describe('sanitizeEmailLocalPartToHandleBase', () => {
  it('sanitizes dots and plus tags', () => {
    expect(sanitizeEmailLocalPartToHandleBase('john.doe+tag@mail.com')).toBe(
      'john_doe_tag',
    );
  });

  it('pads short local parts', () => {
    const base = sanitizeEmailLocalPartToHandleBase('a@x.com');
    expect(base.length).toBeGreaterThanOrEqual(3);
  });
});

describe('handleCandidatesFromBase', () => {
  it('starts with base then numeric prefix variants', () => {
    const candidates = handleCandidatesFromBase('johndoe');
    expect(candidates[0]).toBe('johndoe');
    expect(candidates[1]).toBe('2johndoe');
    expect(candidates[2]).toBe('3johndoe');
  });

  it('skips reserved base names', () => {
    const candidates = handleCandidatesFromBase('admin');
    expect(candidates[0]).not.toBe('admin');
  });
});

describe('isReservedHandle', () => {
  it('includes profile', () => {
    expect(isReservedHandle('profile')).toBe(true);
  });
});
