import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ _id: false })
export class VolumeDiscountTierEmbed {
  @Prop({ required: true })
  minVideos: number;

  @Prop({ required: true })
  discountPercent: number;
}

export const VolumeDiscountTierEmbedSchema =
  SchemaFactory.createForClass(VolumeDiscountTierEmbed);

@Schema({ _id: false })
export class CommercialSettingsEmbed {
  /** ISO 4217 currency code stored uppercase, e.g. "EUR", "USD". */
  @Prop({ required: true, uppercase: true })
  currency: string;

  /** Integer minor units of `currency` (e.g. cents). */
  @Prop({ required: true })
  videoPriceMinor: number;

  @Prop({ type: [VolumeDiscountTierEmbedSchema], default: [] })
  volumeDiscounts: VolumeDiscountTierEmbed[];
}

export const CommercialSettingsEmbedSchema =
  SchemaFactory.createForClass(CommercialSettingsEmbed);
