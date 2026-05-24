const COUNTRY_CODE = /^[A-Z]{2}$/;

export const UNDISCLOSED_DISPLAY_NAME = 'Undisclosed';
export const UNDISCLOSED_SYSTEM_USER_ID = 'peakd:system';

export function normalizeCountryCodeForUndisclosed(code: string): string {
  return code.trim().toUpperCase();
}

export function undisclosedRegionId(countryCode: string): string {
  const cc = normalizeCountryCodeForUndisclosed(countryCode);
  if (!COUNTRY_CODE.test(cc)) {
    throw new Error('Invalid countryCode for undisclosed region');
  }
  return `undisclosed:region:${cc}`;
}

export function undisclosedSpotId(countryCode: string): string {
  const cc = normalizeCountryCodeForUndisclosed(countryCode);
  if (!COUNTRY_CODE.test(cc)) {
    throw new Error('Invalid countryCode for undisclosed spot');
  }
  return `undisclosed:spot:${cc}`;
}

export function isUndisclosedRegionId(
  regionId: string,
  countryCode: string,
): boolean {
  try {
    return regionId === undisclosedRegionId(countryCode);
  } catch {
    return false;
  }
}

export function isUndisclosedSpotId(spotId: string, countryCode: string): boolean {
  try {
    return spotId === undisclosedSpotId(countryCode);
  } catch {
    return false;
  }
}

export function isSessionLocationUndisclosed(
  countryCode: string,
  regionId: string,
  spotId: string,
): boolean {
  return (
    isUndisclosedRegionId(regionId, countryCode) ||
    isUndisclosedSpotId(spotId, countryCode)
  );
}

/** Matches synthetic undisclosed region ids stored on sessions. */
export const UNDISCLOSED_REGION_ID_PATTERN = /^undisclosed:region:[A-Z]{2}$/;
