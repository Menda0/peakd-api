import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type RegionDocument = HydratedDocument<Region>;

@Schema({ collection: 'regions' })
export class Region {
  @Prop({ required: true, unique: true })
  regionId: string;

  @Prop({ required: true, index: true })
  countryCode: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ default: false, index: true })
  verified: boolean;

  @Prop({ type: String, default: null })
  verifiedAt: string | null;

  @Prop({ type: Number, default: 0 })
  verifierCount: number;

  @Prop({ required: true, index: true })
  createdByUserId: string;

  @Prop({ required: true })
  createdAt: string;
}

export const RegionSchema = SchemaFactory.createForClass(Region);

RegionSchema.index({ countryCode: 1, createdByUserId: 1 });
RegionSchema.index({ countryCode: 1, verified: 1 });
RegionSchema.index({ countryCode: 1, name: 1 });
