import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Express } from 'express';
import { VideoFileInterceptor } from './video-file.interceptor';
import { VideoProcessingService } from './video-processing.service';
import { VideoRegistryService } from './video-registry.service';

@Controller('videos')
export class VideoController {
  constructor(
    private readonly videoProcessing: VideoProcessingService,
    private readonly videoRegistry: VideoRegistryService,
  ) {}

  @Get()
  listJobs() {
    return this.videoRegistry.listJobs();
  }

  @Get(':jobId')
  getJob(@Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string) {
    return this.videoRegistry.getJob(jobId);
  }

  @Post('process')
  @UseInterceptors(VideoFileInterceptor)
  async process(@UploadedFile() file: Express.Multer.File) {
    return this.videoProcessing.processUploadedFile(file);
  }
}
