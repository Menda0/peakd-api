import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import { AuthUserId } from '../auth/auth-user.decorator';
import { SharedSessionService } from './shared-session.service';

@Controller('shared-sessions')
@UseGuards(Auth0JwtGuard)
export class SharedSessionAuthController {
  constructor(private readonly sharedSession: SharedSessionService) {}

  @Get(':shareToken')
  getSharedSessionForViewer(
    @AuthUserId() viewerUserId: string,
    @Param('shareToken') shareToken: string,
  ) {
    return this.sharedSession.getPublicSharedSession(shareToken, viewerUserId);
  }
}
