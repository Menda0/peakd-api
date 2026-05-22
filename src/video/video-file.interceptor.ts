import {
  BadRequestException,
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import { diskStorage } from 'multer';
import multer from 'multer';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { VIDEO_CONFIG, VideoConfigValues } from '../config/video.config';

@Injectable()
export class VideoFileInterceptor implements NestInterceptor {
  constructor(private readonly config: ConfigService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const videoCfg = this.config.getOrThrow<VideoConfigValues>(VIDEO_CONFIG);
    const upload = multer({
      limits: { fileSize: videoCfg.maxUploadBytes },
      storage: diskStorage({
        destination(_req, _file, cb) {
          const dir = mkdtempSync(join(tmpdir(), 'peakd-vid-'));
          cb(null, dir);
        },
        filename(_req, file, cb) {
          cb(null, `source${extname(file.originalname) || '.bin'}`);
        },
      }),
    }).single('file');

    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();

    return new Observable((subscriber) => {
      upload(req, res, (err: unknown) => {
        if (err) {
          if (
            err instanceof multer.MulterError &&
            err.code === 'LIMIT_FILE_SIZE'
          ) {
            subscriber.error(new PayloadTooLargeException('File too large'));
            return;
          }
          const msg = err instanceof Error ? err.message : 'Upload failed';
          subscriber.error(new BadRequestException(msg));
          return;
        }
        if (!req.file) {
          subscriber.error(
            new BadRequestException('Missing multipart field "file"'),
          );
          return;
        }
        next.handle().subscribe(subscriber);
      });
    });
  }
}
