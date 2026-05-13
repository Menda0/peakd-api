import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Express } from 'express';
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
  listJobs(@AuthUserId() userId: string) {
    return this.videoRegistry.listJobs(userId);
  }

  @Get(':jobId')
  getJob(
    @AuthUserId() userId: string,
    @Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string,
  ) {
    return this.videoRegistry.getJob(userId, jobId);
  }

  @Post('process')
  @UseInterceptors(VideoFileInterceptor)
  async process(
    @AuthUserId() userId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.videoProcessing.processUploadedFile(file, userId);
  }
}
