import { Controller, Get, Param } from '@nestjs/common';
import { SharedSessionService } from './shared-session.service';

@Controller('public/shared-sessions')
export class PublicSharedSessionController {
  constructor(private readonly sharedSession: SharedSessionService) {}

  @Get(':shareToken')
  getSharedSession(@Param('shareToken') shareToken: string) {
    return this.sharedSession.getPublicSharedSession(shareToken);
  }
}
