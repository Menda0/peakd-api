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
  @Prop({ required: true })
  videoPricePeaks: number;

  @Prop({ type: [VolumeDiscountTierEmbedSchema], default: [] })
  volumeDiscounts: VolumeDiscountTierEmbed[];
}

export const CommercialSettingsEmbedSchema =
  SchemaFactory.createForClass(CommercialSettingsEmbed);
