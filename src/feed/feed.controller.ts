import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import { AuthUserId } from '../auth/auth-user.decorator';
import { FeedService } from './feed.service';

@Controller()
@UseGuards(Auth0JwtGuard)
export class FeedController {
  constructor(private readonly feed: FeedService) {}

  @Get('feed/discover')
  listDiscover(
    @AuthUserId() userId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('countryCode') countryCode?: string,
    @Query('regionId') regionId?: string,
  ) {
    return this.feed.listDiscoverFeed(userId, {
      limit,
      cursor,
      countryCode,
      regionId,
    });
  }

  @Get('feed/my-videos')
  listMyVideos(@AuthUserId() userId: string) {
    return this.feed.listMyVideos(userId);
  }

  @Get('feed/search/geo-suggest')
  geoSuggest(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.feed.geoSuggest(q, limit);
  }

  @Get('feed/search/session-dates')
  searchSessionDates(
    @Query('countryCode') countryCode?: string,
    @Query('regionId') regionId?: string,
    @Query('spotId') spotId?: string,
    @Query('month') month?: string,
  ) {
    return this.feed.searchSessionDates({
      countryCode,
      regionId,
      spotId,
      month,
    });
  }

  @Get('feed/search/sessions')
  searchSessions(
    @AuthUserId() userId: string,
    @Query('countryCode') countryCode?: string,
    @Query('regionId') regionId?: string,
    @Query('spotId') spotId?: string,
    @Query('sessionDate') sessionDate?: string,
  ) {
    return this.feed.searchSessions(userId, {
      countryCode,
      regionId,
      spotId,
      sessionDate,
    });
  }

  @Post('discover/videos/:jobId/publish')
  @HttpCode(HttpStatus.OK)
  publishVideo(
    @AuthUserId() userId: string,
    @Param('jobId') jobId: string,
  ) {
    return this.feed.publishVideoToDiscover(userId, jobId);
  }

  @Post('discover/videos/:jobId/claim')
  @HttpCode(HttpStatus.OK)
  claimVideo(@AuthUserId() userId: string, @Param('jobId') jobId: string) {
    return this.feed.claimVideoWave(userId, jobId);
  }

  @Post('discover/videos/:jobId/buy-claim')
  @HttpCode(HttpStatus.OK)
  buyClaimVideo(
    @AuthUserId() userId: string,
    @Param('jobId') jobId: string,
    @Body() body?: { quantity?: number },
  ) {
    const quantity =
      typeof body?.quantity === 'number' && body.quantity >= 1
        ? Math.floor(body.quantity)
        : 1;
    return this.feed.buyAndClaimVideoWave(userId, jobId, quantity);
  }

  @Post('discover/videos/:jobId/sponsor')
  @HttpCode(HttpStatus.OK)
  sponsorVideo(@AuthUserId() userId: string, @Param('jobId') jobId: string) {
    return this.feed.sponsorVideoWave(userId, jobId);
  }

  @Get('discover/videos/:jobId/checkout')
  getWaveCheckout(
    @AuthUserId() userId: string,
    @Param('jobId') jobId: string,
  ) {
    return this.feed.getWaveCheckoutContext(userId, jobId);
  }

  @Post('discover/cart/quote')
  @HttpCode(HttpStatus.OK)
  quoteUnlockCart(
    @AuthUserId() userId: string,
    @Body() body: { items?: { jobId: string; intent: string }[] },
  ) {
    const items = Array.isArray(body?.items)
      ? body.items
          .filter(
            (row) =>
              row &&
              typeof row.jobId === 'string' &&
              (row.intent === 'buy_claim' || row.intent === 'sponsor'),
          )
          .map((row) => ({
            jobId: row.jobId,
            intent: row.intent as 'buy_claim' | 'sponsor',
          }))
      : [];
    return this.feed.quoteUnlockCart(userId, items);
  }

  @Post('discover/cart/buy-claim-batch')
  @HttpCode(HttpStatus.OK)
  buyClaimCartBatch(
    @AuthUserId() userId: string,
    @Body() body: { jobIds?: string[] },
  ) {
    const jobIds = Array.isArray(body?.jobIds)
      ? body.jobIds.filter((id): id is string => typeof id === 'string')
      : [];
    return this.feed.buyAndClaimVideoWaves(userId, jobIds);
  }
}
