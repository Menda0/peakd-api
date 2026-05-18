export type ViewerGeo = {
  countryCode: string | null;
  homeRegionId: string | null;
};

export type SessionGeo = {
  countryCode: string;
  regionId: string;
};

/** 0 = same region, 1 = same country, 2 = followed (future), 3 = other */
export function computeRelevanceTier(
  viewer: ViewerGeo,
  session: SessionGeo,
): number {
  const homeRegion = viewer.homeRegionId?.trim() || null;
  const country = viewer.countryCode?.trim()?.toUpperCase() || null;
  const sessionRegion = session.regionId?.trim() || '';
  const sessionCountry = session.countryCode?.trim().toUpperCase() || '';

  if (homeRegion && sessionRegion === homeRegion) {
    return 0;
  }
  if (country && sessionCountry === country) {
    return 1;
  }
  return 3;
}

export type DiscoverCursor = {
  tier: number;
  createdAt: string;
  jobId: string;
};

export function encodeDiscoverCursor(cursor: DiscoverCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeDiscoverCursor(raw: string): DiscoverCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    if (
      typeof parsed.tier === 'number' &&
      typeof parsed.createdAt === 'string' &&
      typeof parsed.jobId === 'string' &&
      parsed.createdAt.trim() &&
      parsed.jobId.trim()
    ) {
      return {
        tier: parsed.tier,
        createdAt: parsed.createdAt,
        jobId: parsed.jobId,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function buildCursorMatchFilter(
  cursor: DiscoverCursor,
): Record<string, unknown> {
  return {
    $or: [
      { feedSortTier: { $gt: cursor.tier } },
      {
        feedSortTier: cursor.tier,
        createdAt: { $lt: cursor.createdAt },
      },
      {
        feedSortTier: cursor.tier,
        createdAt: cursor.createdAt,
        jobId: { $lt: cursor.jobId },
      },
    ],
  };
}

/** Viewer’s own personal uploads sort before geo-ranked discover items. */
export function buildFeedSortTierExpression(
  viewerUserId: string,
  baseRelevanceExpression: Record<string, unknown> | string,
): Record<string, unknown> {
  return {
    $cond: [
      {
        $and: [
          { $eq: ['$userId', viewerUserId] },
          { $eq: ['$uploadSource', 'personal'] },
        ],
      },
      -1,
      baseRelevanceExpression,
    ],
  };
}

export function buildRelevanceTierExpression(
  viewerCountryCode: string | null,
  viewerHomeRegionId: string | null,
): Record<string, unknown> {
  const branches: Array<Record<string, unknown>> = [];

  if (viewerHomeRegionId) {
    branches.push({
      case: { $eq: ['$session.regionId', viewerHomeRegionId] },
      then: 0,
    });
  }

  if (viewerCountryCode) {
    const countryMatch = { $eq: ['$session.countryCode', viewerCountryCode] };
    if (viewerHomeRegionId) {
      branches.push({
        case: {
          $and: [
            countryMatch,
            { $ne: ['$session.regionId', viewerHomeRegionId] },
          ],
        },
        then: 1,
      });
    } else {
      branches.push({
        case: countryMatch,
        then: 1,
      });
    }
  }

  return {
    $switch: {
      branches,
      default: 3,
    },
  };
}
