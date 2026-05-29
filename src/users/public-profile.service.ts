import { Injectable, NotFoundException } from '@nestjs/common';
import { FeedService, MyVideoItemDto } from '../feed/feed.service';
import { UserProfileService, SurfLevel } from './user-profile.service';
import { UserPinnedWaveService } from './user-pinned-wave.service';

export interface PublicProfileWaveDto extends MyVideoItemDto {}

export interface PublicProfileDto {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  surfLevel: SurfLevel | null;
  countryCode: string | null;
  homeRegionName: string | null;
  pinnedJobIds: string[];
  waves: PublicProfileWaveDto[];
}

@Injectable()
export class PublicProfileService {
  constructor(
    private readonly userProfiles: UserProfileService,
    private readonly pinnedWaves: UserPinnedWaveService,
    private readonly feed: FeedService,
  ) {}

  async getPublicProfile(handle: string): Promise<PublicProfileDto> {
    const profile = await this.userProfiles.findByHandle(handle);
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }

    const profileDto = await this.userProfiles.getProfileDto(profile.userId);
    const pinnedJobIds = await this.pinnedWaves.listPinnedJobIdsForUser(
      profile.userId,
    );
    const allWaves = await this.feed.listMyVideosForPublicProfile(
      profile.userId,
    );

    return {
      handle: profile.handle,
      displayName: profileDto.displayName,
      avatarUrl: profileDto.avatarUrl,
      surfLevel: profileDto.surfLevel,
      countryCode: profileDto.countryCode,
      homeRegionName: profileDto.homeRegionName,
      pinnedJobIds,
      waves: allWaves,
    };
  }
}
