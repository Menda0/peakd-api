import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
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

  @Post('me/onboarding-prompt')
  recordOnboardingPrompt(@AuthUserId() userId: string) {
    return this.userProfiles.recordOnboardingPrompt(userId);
  }
}
