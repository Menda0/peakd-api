import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import { basename, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Model } from 'mongoose';
import { S3Service } from '../s3/s3.service';
import { SurfSession } from './schemas/surf-session.schema';
import { VideoJob } from '../video/schemas/video-job.schema';
import { StudioService } from './studio.service';

export type CloseSessionResult = {
  sessionId: string;
  status: 'closed';
  exportStatus: 'processing';
};

export type SessionExportDownloadDto = {
  downloadUrl: string;
};

function sanitizeVideoBaseName(originalFilename: string, used: Set<string>): string {
  const raw = basename(originalFilename).replace(/\.[^.]+$/, '');
  const cleaned =
    raw
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'video';
  let name = cleaned;
  let n = 2;
  while (used.has(name.toLowerCase())) {
    name = `${cleaned}-${n++}`;
  }
  used.add(name.toLowerCase());
  return name;
}

@Injectable()
export class SessionExportService {
  private readonly logger = new Logger(SessionExportService.name);

  constructor(
    @InjectModel(SurfSession.name)
    private readonly surfSessionModel: Model<SurfSession>,
    @InjectModel(VideoJob.name)
    private readonly videoJobModel: Model<VideoJob>,
    private readonly s3: S3Service,
    private readonly studio: StudioService,
  ) {}

  async closeSession(
    userId: string,
    sessionId: string,
  ): Promise<CloseSessionResult> {
    const session = await this.studio.getSessionForExport(userId, sessionId);

    if (session.status === 'closed') {
      throw new BadRequestException('Session is already closed');
    }

    const processingCount = await this.videoJobModel
      .countDocuments({
        userId,
        surfSessionId: sessionId,
        status: 'processing',
      })
      .exec();

    if (processingCount > 0) {
      throw new ConflictException(
        'Cannot close session while videos are still processing',
      );
    }

    const closedAt = new Date().toISOString();
    await this.surfSessionModel
      .updateOne(
        { sessionId, userId },
        {
          $set: {
            status: 'closed',
            closedAt,
            exportStatus: 'processing',
            exportErrorMessage: null,
          },
        },
      )
      .exec();

    void this.buildExportZip(userId, sessionId).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Export failed for session ${sessionId}: ${msg}`,
        err instanceof Error ? err.stack : undefined,
      );
    });

    return {
      sessionId,
      status: 'closed',
      exportStatus: 'processing',
    };
  }

  async getExportDownloadUrl(
    userId: string,
    sessionId: string,
  ): Promise<SessionExportDownloadDto> {
    const session = await this.studio.getSessionForExport(userId, sessionId);

    if (session.exportStatus === 'ready' && session.exportZipKey) {
      const downloadUrl = await this.s3.presignedGetUrl(session.exportZipKey);
      return { downloadUrl };
    }

    throw new ConflictException({
      message: 'Export is not ready for download',
      exportStatus: session.exportStatus ?? 'idle',
      exportErrorMessage: session.exportErrorMessage ?? null,
    });
  }

  private exportZipKey(userId: string, sessionId: string): string {
    return `sessions/${userId}/${sessionId}/export.zip`;
  }

  private async buildExportZip(
    userId: string,
    sessionId: string,
  ): Promise<void> {
    const workDir = await mkdtemp(join(tmpdir(), 'peakd-session-export-'));
    const zipPath = join(workDir, 'export.zip');

    try {
      const jobs = await this.videoJobModel
        .find({
          userId,
          surfSessionId: sessionId,
          status: 'completed',
        })
        .sort({ createdAt: 1 })
        .lean()
        .exec();

      if (jobs.length === 0) {
        await this.surfSessionModel
          .updateOne(
            { sessionId, userId },
            {
              $set: {
                exportStatus: 'failed',
                exportErrorMessage:
                  'No completed videos to include in the export',
              },
            },
          )
          .exec();
        return;
      }

      const usedNames = new Set<string>();
      const stagingDir = join(workDir, 'staging');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(stagingDir, { recursive: true });

      await this.writeZip(zipPath, async (archive) => {
        for (const job of jobs) {
          const videoName = sanitizeVideoBaseName(
            job.originalFilename ?? 'video',
            usedNames,
          );
          const processedKey =
            job.processedKey ?? `videos/${userId}/${job.jobId}/processed.webm`;

          const videoLocal = join(stagingDir, `${job.jobId}-video.webm`);
          await this.s3.downloadToFile(processedKey, videoLocal);
          archive.file(videoLocal, { name: `${videoName}.webm` });

          const snapshotKeys = job.snapshotKeys ?? [];
          for (const snapKey of snapshotKeys) {
            const snapBase = basename(snapKey);
            const snapLocal = join(stagingDir, `${job.jobId}-${snapBase}`);
            await this.s3.downloadToFile(snapKey, snapLocal);
            archive.file(snapLocal, {
              name: `${videoName}/${snapBase}`,
            });
          }
        }
      });

      const zipKey = this.exportZipKey(userId, sessionId);
      await this.s3.uploadFile({
        key: zipKey,
        filePath: zipPath,
        contentType: 'application/zip',
      });

      await this.surfSessionModel
        .updateOne(
          { sessionId, userId },
          {
            $set: {
              exportStatus: 'ready',
              exportZipKey: zipKey,
              exportErrorMessage: null,
            },
          },
        )
        .exec();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.surfSessionModel
        .updateOne(
          { sessionId, userId },
          {
            $set: {
              exportStatus: 'failed',
              exportErrorMessage: msg,
            },
          },
        )
        .exec();
      throw err;
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private writeZip(
    zipPath: string,
    addEntries: (archive: archiver.Archiver) => Promise<void>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });

      output.on('close', () => resolve());
      output.on('error', reject);
      archive.on('error', reject);

      archive.pipe(output);

      void addEntries(archive)
        .then(() => archive.finalize())
        .catch(reject);
    });
  }
}
