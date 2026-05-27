import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import { FeedService, type UnlockCartIntent } from './feed.service';

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
    @Query('regionIds') regionIds?: string,
    @Query('spotIds') spotIds?: string,
  ) {
    return this.feed.listDiscoverFeed(userId, {
      limit,
      cursor,
      countryCode,
      regionId,
      regionIds,
      spotIds,
    });
  }

  @Get('feed/my-videos')
  listMyVideos(@AuthUserId() userId: string) {
    return this.feed.listMyVideos(userId);
  }

  @Get('feed/search/geo-suggest')
  geoSuggest(@Query('q') q?: string, @Query('limit') limit?: string) {
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
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.feed.searchSessions(userId, {
      countryCode,
      regionId,
      spotId,
      sessionDate,
      limit,
      cursor,
    });
  }

  @Get('feed/latest-sessions')
  latestSessions(
    @AuthUserId() userId: string,
    @Query('limit') limit?: string,
  ) {
    return this.feed.listLatestSessions(userId, limit);
  }

  @Get('feed/latest-waves')
  latestWaves(@AuthUserId() userId: string, @Query('limit') limit?: string) {
    return this.feed.listLatestWaves(userId, limit);
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

  /**
   * Start a Stripe Checkout for a single wave. Returns `{ url, orderId }`;
   * the client redirects the browser to `url`. The order is fulfilled by
   * the Stripe webhook after the buyer completes payment.
   */
  @Post('discover/videos/:jobId/checkout')
  @HttpCode(HttpStatus.OK)
  singleWaveCheckout(
    @AuthUserId() userId: string,
    @Param('jobId') jobId: string,
    @Body() body?: { intent?: string },
  ) {
    const intent: UnlockCartIntent =
      body?.intent === 'sponsor' ? 'sponsor' : 'buy_claim';
    return this.feed.startSingleWaveCheckout(userId, jobId, intent);
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
            intent: row.intent as UnlockCartIntent,
          }))
      : [];
    return this.feed.quoteUnlockCart(userId, items);
  }

  /**
   * Start a Stripe Checkout for one partner's cart group. Buyers with items
   * from multiple partners call this endpoint once per partner; the cart UI
   * surfaces one Checkout button per group.
   */
  @Post('discover/cart/checkout')
  @HttpCode(HttpStatus.OK)
  partnerCartCheckout(
    @AuthUserId() userId: string,
    @Body()
    body: {
      partnerUserId?: string;
      jobIds?: string[];
      intent?: string;
    },
  ) {
    const partnerUserId = body?.partnerUserId?.trim();
    if (!partnerUserId) {
      throw new BadRequestException('partnerUserId is required');
    }
    const jobIds = Array.isArray(body?.jobIds)
      ? body.jobIds.filter((id): id is string => typeof id === 'string')
      : [];
    if (jobIds.length === 0) {
      throw new BadRequestException('jobIds is required');
    }
    const intent: UnlockCartIntent =
      body?.intent === 'sponsor' ? 'sponsor' : 'buy_claim';
    return this.feed.startPartnerCheckout(
      userId,
      partnerUserId,
      jobIds,
      intent,
    );
  }

  @Get('orders/:orderId')
  getOrderStatus(
    @AuthUserId() userId: string,
    @Param('orderId') orderId: string,
  ) {
    return this.feed.getOrderStatus(userId, orderId);
  }

  @Post('discover/videos/:jobId/shaka')
  @HttpCode(HttpStatus.OK)
  shakaVideo(
    @AuthUserId() userId: string,
    @Param('jobId') jobId: string,
  ) {
    return this.feed.shakaVideo(userId, jobId);
  }

  @Delete('discover/videos/:jobId/shaka')
  @HttpCode(HttpStatus.OK)
  unshakaVideo(
    @AuthUserId() userId: string,
    @Param('jobId') jobId: string,
  ) {
    return this.feed.unshakaVideo(userId, jobId);
  }
}
