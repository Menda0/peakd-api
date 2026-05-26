import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  CommercialSettingsEmbed,
  CommercialSettingsEmbedSchema,
} from '../../commercial/schemas/commercial-settings.embed';

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

  @Prop({ type: String, enum: ['open', 'closed'], default: 'open' })
  status: 'open' | 'closed';

  /** Partner studio folders vs personal feed uploads (hidden from studio UI). */
  @Prop({ type: String, enum: ['studio', 'personal'], default: 'studio', index: true })
  sessionKind: 'studio' | 'personal';

  @Prop({ type: String, default: null })
  closedAt: string | null;

  @Prop({
    type: String,
    enum: ['idle', 'processing', 'ready', 'failed'],
    default: 'idle',
  })
  exportStatus: 'idle' | 'processing' | 'ready' | 'failed';

  @Prop({ type: String, default: null })
  exportZipKey: string | null;

  @Prop({ type: String, default: null })
  exportErrorMessage: string | null;

  @Prop({
    type: String,
    enum: ['idle', 'processing', 'ready', 'failed'],
    default: 'idle',
  })
  rawExportStatus: 'idle' | 'processing' | 'ready' | 'failed';

  @Prop({ type: String, default: null })
  rawExportZipKey: string | null;

  @Prop({ type: String, default: null })
  rawExportErrorMessage: string | null;

  /** ISO instant after which raw ZIP download is refused (UI retention hint). */
  @Prop({ type: String, default: null })
  rawExportExpiresAt: string | null;

  /** Unguessable token for public session viewer (set when share is enabled). */
  @Prop({ type: String, required: false })
  shareToken?: string;

  /** Commercial session: feed shows snapshot carousel; waves unlock via Peaks. */
  @Prop({ type: Boolean, default: false, index: true })
  isCommercial: boolean;

  /** Per-session pricing override; null inherits partner profile defaults. */
  @Prop({ type: CommercialSettingsEmbedSchema, default: null })
  commercialSettings: CommercialSettingsEmbed | null;
}

export const SurfSessionSchema = SchemaFactory.createForClass(SurfSession);

SurfSessionSchema.index({ userId: 1, createdAt: -1 });
SurfSessionSchema.index({ shareToken: 1 }, { unique: true, sparse: true });
SurfSessionSchema.index({ countryCode: 1, sessionDate: 1 });
SurfSessionSchema.index({ regionId: 1, sessionDate: 1 });
SurfSessionSchema.index({ spotId: 1, sessionDate: 1 });
