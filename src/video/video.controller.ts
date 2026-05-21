import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Express, Request } from 'express';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import { AuthUserId } from '../auth/auth-user.decorator';
import { VideoFileInterceptor } from './video-file.interceptor';
import { VideoProcessingService } from './video-processing.service';
import { VideoRegistryService } from './video-registry.service';

@Controller('videos')
@UseGuards(Auth0JwtGuard)
export class VideoController {
  constructor(
    private readonly videoProcessing: VideoProcessingService,
    private readonly videoRegistry: VideoRegistryService,
  ) {}

  @Get()
  listJobs(
    @AuthUserId() userId: string,
    @Query('surfSessionId') surfSessionId?: string,
  ) {
    return this.videoRegistry.listJobs(userId, surfSessionId);
  }

  @Get(':jobId')
  getJob(
    @AuthUserId() userId: string,
    @Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string,
  ) {
    return this.videoRegistry.getJob(userId, jobId);
  }

  @Delete(':jobId')
  @HttpCode(HttpStatus.OK)
  deleteJob(
    @AuthUserId() userId: string,
    @Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string,
  ) {
    return this.videoRegistry.deleteJob(userId, jobId);
  }

  @Post('process')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(VideoFileInterceptor)
  async process(
    @AuthUserId() userId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
  ) {
    const raw =
      typeof req.body?.surfSessionId === 'string'
        ? req.body.surfSessionId.trim()
        : '';
    const surfSessionId = raw === '' ? null : raw;
    const sourceRaw =
      typeof req.body?.uploadSource === 'string'
        ? req.body.uploadSource.trim()
        : 'studio';
    const uploadSource = sourceRaw === 'personal' ? 'personal' : 'studio';
    return this.videoProcessing.processUploadedFile(
      file,
      userId,
      surfSessionId,
      uploadSource,
    );
  }
}
