import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import { AuthUserId } from '../auth/auth-user.decorator';
import { SessionExportService } from './session-export.service';
import { StudioService } from './studio.service';

@Controller('studio')
@UseGuards(Auth0JwtGuard)
export class StudioController {
  constructor(
    private readonly studio: StudioService,
    private readonly sessionExport: SessionExportService,
  ) {}

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

  @Post('sessions/:sessionId/close')
  @HttpCode(HttpStatus.ACCEPTED)
  closeSession(
    @AuthUserId() userId: string,
    @Param('sessionId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
  ) {
    return this.sessionExport.closeSession(userId, sessionId);
  }

  @Get('sessions/:sessionId/export/raw/download')
  async getSessionRawExportDownload(
    @AuthUserId() userId: string,
    @Param('sessionId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
  ): Promise<StreamableFile> {
    const opened = await this.sessionExport.openRawExportDownload(
      userId,
      sessionId,
    );
    return new StreamableFile(opened.stream, {
      type: opened.contentType,
      disposition: `attachment; filename="${opened.filename}"`,
      ...(opened.contentLength != null ? { length: opened.contentLength } : {}),
    });
  }

  @Get('sessions/:sessionId/export/download')
  async getSessionExportDownload(
    @AuthUserId() userId: string,
    @Param('sessionId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
  ): Promise<StreamableFile> {
    const opened = await this.sessionExport.openProcessedExportDownload(
      userId,
      sessionId,
    );
    return new StreamableFile(opened.stream, {
      type: opened.contentType,
      disposition: `attachment; filename="${opened.filename}"`,
      ...(opened.contentLength != null ? { length: opened.contentLength } : {}),
    });
  }

  @Patch('sessions/:sessionId')
  updateSession(
    @AuthUserId() userId: string,
    @Param('sessionId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
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
    return this.studio.updateSession(userId, sessionId, body);
  }
}
