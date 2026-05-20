export type VolumeDiscountTier = {
  minVideos: number;
  discountPercent: number;
};

export type CommercialSettings = {
  videoPricePeaks: number;
  volumeDiscounts: VolumeDiscountTier[];
};

export const DEFAULT_VOLUME_DISCOUNTS: VolumeDiscountTier[] = [
  { minVideos: 3, discountPercent: 10 },
  { minVideos: 5, discountPercent: 15 },
  { minVideos: 10, discountPercent: 20 },
];
