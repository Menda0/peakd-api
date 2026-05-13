import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import { AuthUserId } from '../auth/auth-user.decorator';
import { StudioService } from './studio.service';

@Controller('studio')
@UseGuards(Auth0JwtGuard)
export class StudioController {
  constructor(private readonly studio: StudioService) {}

  @Get('regions')
  listRegions(
    @AuthUserId() userId: string,
    @Query('countryCode') countryCode: string,
  ) {
    return this.studio.listRegions(userId, countryCode ?? '');
  }

  @Post('regions')
  createRegion(
    @AuthUserId() userId: string,
    @Body() body: { countryCode?: string; name?: string },
  ) {
    return this.studio.createRegion(userId, body);
  }

  @Get('spots')
  listSpots(
    @AuthUserId() userId: string,
    @Query('regionId') regionId: string,
  ) {
    return this.studio.listSpots(userId, regionId ?? '');
  }

  @Post('spots')
  createSpot(
    @AuthUserId() userId: string,
    @Body() body: { regionId?: string; name?: string },
  ) {
    return this.studio.createSpot(userId, body);
  }

  @Get('sessions')
  listSessions(@AuthUserId() userId: string) {
    return this.studio.listSessions(userId);
  }

  @Post('sessions')
  createSession(
    @AuthUserId() userId: string,
    @Body()
    body: {
      countryCode?: string;
      regionId?: string;
      spotId?: string;
      sessionDate?: string;
      sessionTime?: string;
      durationMinutes?: number | string;
      conditionsRating?: number | string | null;
      waveTypes?: unknown;
    },
  ) {
    return this.studio.createSession(userId, body);
  }

  @Get('sessions/:sessionId')
  getSession(
    @AuthUserId() userId: string,
    @Param('sessionId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
  ) {
    return this.studio.getSession(userId, sessionId);
  }
}
