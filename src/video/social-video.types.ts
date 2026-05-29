export const SOCIAL_VARIANT_KINDS = ['reel', 'story', 'post'] as const;
export type SocialVariantKind = (typeof SOCIAL_VARIANT_KINDS)[number];

export type SocialVideoProfile = {
  kind: SocialVariantKind;
  label: string;
  aspectRatio: string;
  width: number;
  height: number;
  outputBasename: string;
};

export type RenderedSocialVariant = {
  kind: SocialVariantKind;
  label: string;
  aspectRatio: string;
  videoKey: string;
  thumbnailKey: string;
  durationSec: number;
};
