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

  /** Local wall time HH:mm (24h) */
  @Prop({ type: String, default: '12:00' })
  sessionTime: string;

  /** Surf block length in minutes */
  @Prop({ type: Number, default: 120 })
  durationMinutes: number;

  /** 1–5 conditions rating; null if not set (legacy) */
  @Prop({ type: Number, default: null })
  conditionsRating: number | null;

  /** Wave character tags, e.g. mushy, clean */
  @Prop({ type: [String], default: [] })
  waveTypes: string[];

  @Prop({ required: true })
  createdAt: string;
}

export const SurfSessionSchema = SchemaFactory.createForClass(SurfSession);

SurfSessionSchema.index({ userId: 1, createdAt: -1 });
