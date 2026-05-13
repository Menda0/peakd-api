import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SpotDocument = HydratedDocument<Spot>;

@Schema({ collection: 'spots' })
export class Spot {
  @Prop({ required: true, unique: true })
  spotId: string;

  @Prop({ required: true, index: true })
  regionId: string;

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

export const SpotSchema = SchemaFactory.createForClass(Spot);

SpotSchema.index({ regionId: 1, createdByUserId: 1 });
SpotSchema.index({ regionId: 1, verified: 1 });
SpotSchema.index({ regionId: 1, name: 1 });
