import {
  Body,
  Controller,
  Get,
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
import {
  UserProfilePatchBody,
  UserProfileService,
} from './user-profile.service';

@Controller('users')
@UseGuards(Auth0JwtGuard)
export class UsersController {
  constructor(private readonly userProfiles: UserProfileService) {}

  @Get('me')
  getMe(@AuthUserId() userId: string) {
    return this.userProfiles.getMe(userId);
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
}
