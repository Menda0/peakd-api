import {
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
  ) {
    return this.feed.listDiscoverFeed(userId, { limit, cursor });
  }

  @Post('discover/videos/:jobId/publish')
  @HttpCode(HttpStatus.OK)
  publishVideo(
    @AuthUserId() userId: string,
    @Param('jobId') jobId: string,
  ) {
    return this.feed.publishVideoToDiscover(userId, jobId);
  }
}
