import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  SurfSession,
  SurfSessionDocument,
} from './schemas/surf-session.schema';

/** Ensures shareToken unique index is sparse so many sessions can exist without a token. */
@Injectable()
export class SurfSessionIndexesService implements OnModuleInit {
  constructor(
    @InjectModel(SurfSession.name)
    private readonly surfSessionModel: Model<SurfSessionDocument>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.surfSessionModel
      .updateMany({ shareToken: null }, { $unset: { shareToken: 1 } })
      .exec();

    const collection = this.surfSessionModel.collection;
    const indexes = await collection.indexes();
    const shareIdx = indexes.find((i) => i.name === 'shareToken_1');
    if (shareIdx && !shareIdx.sparse) {
      await collection.dropIndex('shareToken_1');
    }
    await this.surfSessionModel.syncIndexes();
  }
}
