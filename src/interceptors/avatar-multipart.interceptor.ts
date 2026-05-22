import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import multer from 'multer';
import { Observable } from 'rxjs';

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

/** Multer memory upload for field `file` (JPEG/PNG/WebP/GIF, max 5 MB). */
@Injectable()
export class AvatarMultipartInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const upload = multer({
      limits: { fileSize: MAX_BYTES },
      storage: multer.memoryStorage(),
      fileFilter(_req, file, cb) {
        if (ALLOWED.has(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new Error('Avatar must be JPEG, PNG, WebP, or GIF'));
        }
      },
    }).single('file');

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    return new Observable((subscriber) => {
      upload(req, res, (err: unknown) => {
        if (err) {
          if (
            err instanceof multer.MulterError &&
            err.code === 'LIMIT_FILE_SIZE'
          ) {
            subscriber.error(
              new PayloadTooLargeException('Avatar must be 5 MB or smaller'),
            );
            return;
          }
          if (err instanceof BadRequestException) {
            subscriber.error(err);
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
