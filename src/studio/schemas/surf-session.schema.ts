import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SurfSessionDocument = HydratedDocument<SurfSession>;

@Schema({ collection: 'surf_sessions' })
export class SurfSession {
  @Prop({ required: true, unique: true })
  sessionId: string;

  @Prop({ required: true, index: true })
  userId: string;

  @Prop({ required: true })
  countryCode: string;

  @Prop({ required: true })
  regionId: string;

  @Prop({ required: true })
  spotId: string;

  /** Calendar date YYYY-MM-DD */
  @Prop({ required: true })
  sessionDate: string;

  @Prop({ required: true })
  createdAt: string;
}

export const SurfSessionSchema = SchemaFactory.createForClass(SurfSession);

SurfSessionSchema.index({ userId: 1, createdAt: -1 });
