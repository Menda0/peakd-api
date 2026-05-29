import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Express } from 'express';
import { AvatarMultipartInterceptor } from '../interceptors/avatar-multipart.interceptor';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import { AuthUserId } from '../auth/auth-user.decorator';
import { AuthEmail } from '../auth/auth-email.decorator';
import {
  UserProfilePatchBody,
  UserProfileService,
} from './user-profile.service';
import { UserPinnedWaveService } from './user-pinned-wave.service';

@Controller('users')
@UseGuards(Auth0JwtGuard)
export class UsersController {
  constructor(
    private readonly userProfiles: UserProfileService,
    private readonly pinnedWaves: UserPinnedWaveService,
  ) {}

  @Get('me')
  getMe(@AuthUserId() userId: string, @AuthEmail() email: string | null) {
    return this.userProfiles.getMe(userId, email);
  }

  @Patch('me')
  patchMe(
    @AuthUserId() userId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.userProfiles.patchMe(userId, body as UserProfilePatchBody);
  }

  @Post('me/avatar')
  @UseInterceptors(AvatarMultipartInterceptor)
  uploadAvatar(
    @AuthUserId() userId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.userProfiles.uploadAvatarMultipart(userId, file);
  }

  @Get('me/pinned-waves')
  listPinnedWaves(@AuthUserId() userId: string) {
    return this.pinnedWaves.listPinnedJobIds(userId);
  }

  @Post('me/pinned-waves/:jobId')
  pinWave(@AuthUserId() userId: string, @Param('jobId') jobId: string) {
    return this.pinnedWaves.pinWave(userId, jobId);
  }

  @Delete('me/pinned-waves/:jobId')
  unpinWave(@AuthUserId() userId: string, @Param('jobId') jobId: string) {
    return this.pinnedWaves.unpinWave(userId, jobId);
  }
}
