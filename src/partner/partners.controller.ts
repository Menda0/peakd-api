import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import { AuthUserId } from '../auth/auth-user.decorator';
import {
  PartnerProfilePatchBody,
  PartnerProfileService,
} from './partner-profile.service';

/** Partner-only UX is enforced in Next.js; this API requires only a valid API access token and scopes data by `sub`. */
@Controller('partners')
@UseGuards(Auth0JwtGuard)
export class PartnersController {
  constructor(private readonly partnerProfile: PartnerProfileService) {}

  @Get('me')
  getMe(@AuthUserId() userId: string) {
    return this.partnerProfile.getMe(userId);
  }

  @Patch('me')
  patchMe(
    @AuthUserId() userId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.partnerProfile.patchMe(userId, body as PartnerProfilePatchBody);
  }

  @Post('me/avatar/presign')
  presignAvatar(
    @AuthUserId() userId: string,
    @Body() body: { contentType?: string; filename?: string },
  ) {
    if (!body?.contentType || typeof body.contentType !== 'string') {
      throw new BadRequestException('contentType is required');
    }
    return this.partnerProfile.presignAvatar(
      userId,
      body.contentType,
      typeof body.filename === 'string' ? body.filename : undefined,
    );
  }
}
