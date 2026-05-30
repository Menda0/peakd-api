import { Controller, Get, Query } from '@nestjs/common';
import { FeedService } from './feed.service';

@Controller('public/landing')
export class PublicLandingController {
  constructor(private readonly feed: FeedService) {}

  @Get()
  listLanding(
    @Query('countryCode') countryCode?: string,
    @Query('wavesLimit') wavesLimit?: string,
    @Query('sessionsLimit') sessionsLimit?: string,
  ) {
    return this.feed.listPublicLanding({
      countryCode,
      wavesLimit,
      sessionsLimit,
    });
  }
}
