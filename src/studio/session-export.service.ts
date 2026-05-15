import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Readable } from 'node:stream';
import { Model } from 'mongoose';
import { S3Service } from '../s3/s3.service';
import { SurfSession } from './schemas/surf-session.schema';
import { VideoJob } from '../video/schemas/video-job.schema';
import { StudioService } from './studio.service';

export type CloseSessionResult = {
  sessionId: string;
  status: 'closed';
  exportStatus: 'processing';
  rawExportStatus: 'processing';
};

export type OpenedSessionExportDownload = {
  stream: Readable;
  contentType: string;
  contentLength?: number;
  filename: string;
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
    private readonly config: ConfigService,
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
            exportZipKey: null,
            exportErrorMessage: null,
            rawExportStatus: 'processing',
            rawExportZipKey: null,
            rawExportErrorMessage: null,
            rawExportExpiresAt: null,
          },
        },
      )
      .exec();

    void this.runSessionExports(userId, sessionId).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Session export failed for ${sessionId}: ${msg}`,
        err instanceof Error ? err.stack : undefined,
      );
    });

    return {
      sessionId,
      status: 'closed',
      exportStatus: 'processing',
      rawExportStatus: 'processing',
    };
  }

  async openRawExportDownload(
    userId: string,
    sessionId: string,
  ): Promise<OpenedSessionExportDownload> {
    const session = await this.studio.getSessionForExport(userId, sessionId);

    if (session.rawExportStatus !== 'ready' || !session.rawExportZipKey) {
      throw new ConflictException({
        message: 'Raw export is not ready for download',
        rawExportStatus: session.rawExportStatus ?? 'idle',
        rawExportErrorMessage: session.rawExportErrorMessage ?? null,
      });
    }

    const expiresAt = session.rawExportExpiresAt
      ? Date.parse(session.rawExportExpiresAt)
      : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new GoneException('Raw export download window has expired');
    }

    const { stream, contentLength, contentType } =
      await this.s3.getObjectReadStreamRaw(session.rawExportZipKey);
    return {
      stream,
      contentType,
      contentLength,
      filename: 'session-raw-export.zip',
    };
  }

  async openProcessedExportDownload(
    userId: string,
    sessionId: string,
  ): Promise<OpenedSessionExportDownload> {
    const session = await this.studio.getSessionForExport(userId, sessionId);

    if (session.exportStatus === 'ready' && session.exportZipKey) {
      const { stream, contentLength, contentType } =
        await this.s3.getObjectReadStream(session.exportZipKey);
      return {
        stream,
        contentType,
        contentLength,
        filename: 'session-export.zip',
      };
    }

    throw new ConflictException({
      message: 'Export is not ready for download',
      exportStatus: session.exportStatus ?? 'idle',
      exportErrorMessage: session.exportErrorMessage ?? null,
    });
  }

  private rawRetentionDays(): number {
    const raw = this.config.get<string>('RAW_EXPORT_RETENTION_DAYS');
    const n =
      raw !== undefined && raw !== '' ? parseInt(raw, 10) : 30;
    if (!Number.isFinite(n) || n < 1) {
      return 30;
    }
    return Math.min(n, 3650);
  }

  private async runSessionExports(
    userId: string,
    sessionId: string,
  ): Promise<void> {
    await Promise.all([
      this.buildProcessedExportZip(userId, sessionId),
      this.buildRawExportZip(userId, sessionId),
    ]);
  }

  private rawExportZipKey(userId: string, sessionId: string): string {
    return `sessions/${userId}/${sessionId}/raw-export.zip`;
  }

  private async buildRawExportZip(
    userId: string,
    sessionId: string,
  ): Promise<void> {
    const workDir = await mkdtemp(join(tmpdir(), 'peakd-session-raw-export-'));
    const zipPath = join(workDir, 'raw-export.zip');

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

      const jobsWithRaw = jobs.filter((j) => Boolean(j.rawOriginalKey));
      if (jobsWithRaw.length === 0) {
        await this.surfSessionModel
          .updateOne(
            { sessionId, userId },
            {
              $set: {
                rawExportStatus: 'failed',
                rawExportErrorMessage:
                  'No completed videos with raw originals to include',
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
        for (const job of jobsWithRaw) {
          const rawKey = job.rawOriginalKey as string;
          const videoName = sanitizeVideoBaseName(
            job.originalFilename ?? 'video',
            usedNames,
          );
          const rootExt = extname(rawKey).toLowerCase() || '.bin';
          const rawLocal = join(stagingDir, `${job.jobId}-original${rootExt}`);
          await this.s3.downloadToFileRaw(rawKey, rawLocal);
          archive.file(rawLocal, { name: `${videoName}${rootExt}` });

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

      const zipKey = this.rawExportZipKey(userId, sessionId);
      await this.s3.uploadFileRaw({
        key: zipKey,
        filePath: zipPath,
        contentType: 'application/zip',
      });

      const retentionMs = this.rawRetentionDays() * 86_400_000;
      const rawExportExpiresAt = new Date(
        Date.now() + retentionMs,
      ).toISOString();

      await this.surfSessionModel
        .updateOne(
          { sessionId, userId },
          {
            $set: {
              rawExportStatus: 'ready',
              rawExportZipKey: zipKey,
              rawExportErrorMessage: null,
              rawExportExpiresAt,
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
              rawExportStatus: 'failed',
              rawExportErrorMessage: msg,
            },
          },
        )
        .exec();
      throw err;
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private exportZipKey(userId: string, sessionId: string): string {
    return `sessions/${userId}/${sessionId}/export.zip`;
  }

  private async buildProcessedExportZip(
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
