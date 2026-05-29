import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { VideoJob } from '../video/schemas/video-job.schema';
import { UserPinnedWave } from './schemas/user-pinned-wave.schema';

@Injectable()
export class UserPinnedWaveService {
  constructor(
    @InjectModel(UserPinnedWave.name)
    private readonly pinnedWaveModel: Model<UserPinnedWave>,
    @InjectModel(VideoJob.name)
    private readonly videoJobModel: Model<VideoJob>,
  ) {}

  private async userOwnsWave(userId: string, jobId: string): Promise<boolean> {
    const id = jobId.trim();
    if (!id) return false;
    const personal = await this.videoJobModel
      .findOne({ jobId: id, userId, uploadSource: 'personal' })
      .lean()
      .exec();
    if (personal) return true;
    const claimed = await this.videoJobModel
      .findOne({
        jobId: id,
        claimedByUserId: userId,
        claimStatus: 'claimed',
      })
      .lean()
      .exec();
    return Boolean(claimed);
  }

  async listPinnedJobIds(userId: string): Promise<{ jobIds: string[] }> {
    const rows = await this.pinnedWaveModel
      .find({ userId })
      .sort({ pinnedAt: -1 })
      .lean()
      .exec();
    return { jobIds: rows.map((r) => r.jobId) };
  }

  async listPinnedJobIdsForUser(userId: string): Promise<string[]> {
    const { jobIds } = await this.listPinnedJobIds(userId);
    return jobIds;
  }

  async pinWave(userId: string, jobId: string): Promise<{ jobIds: string[] }> {
    const id = jobId.trim();
    if (!id) {
      throw new BadRequestException('jobId is required');
    }
    if (!(await this.userOwnsWave(userId, id))) {
      throw new NotFoundException('Wave not found in your videos');
    }
    try {
      await this.pinnedWaveModel.create({ userId, jobId: id, pinnedAt: new Date() });
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code !== 11000) throw e;
    }
    return this.listPinnedJobIds(userId);
  }

  async unpinWave(userId: string, jobId: string): Promise<{ jobIds: string[] }> {
    const id = jobId.trim();
    if (!id) {
      throw new BadRequestException('jobId is required');
    }
    await this.pinnedWaveModel.deleteOne({ userId, jobId: id }).exec();
    return this.listPinnedJobIds(userId);
  }
}
