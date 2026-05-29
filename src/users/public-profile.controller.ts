import { Controller, Get, Param } from '@nestjs/common';
import { PublicProfileService } from './public-profile.service';

@Controller('public/profiles')
export class PublicProfileController {
  constructor(private readonly publicProfiles: PublicProfileService) {}

  @Get(':handle')
  getProfile(@Param('handle') handle: string) {
    return this.publicProfiles.getPublicProfile(handle);
  }
}
