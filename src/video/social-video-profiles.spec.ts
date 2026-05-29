import { SOCIAL_VIDEO_PROFILES } from './social-video-profiles';
import { SOCIAL_VARIANT_KINDS } from './social-video.types';

describe('SOCIAL_VIDEO_PROFILES', () => {
  it('defines reel, story, and post variants', () => {
    expect(SOCIAL_VIDEO_PROFILES.map((p) => p.kind)).toEqual([
      ...SOCIAL_VARIANT_KINDS,
    ]);
  });

  it('uses MP4 output basenames', () => {
    for (const profile of SOCIAL_VIDEO_PROFILES) {
      expect(profile.outputBasename.endsWith('.mp4')).toBe(true);
    }
  });

  it('uses vertical aspect for reel and story and square for post', () => {
    const reel = SOCIAL_VIDEO_PROFILES.find((p) => p.kind === 'reel');
    const story = SOCIAL_VIDEO_PROFILES.find((p) => p.kind === 'story');
    const post = SOCIAL_VIDEO_PROFILES.find((p) => p.kind === 'post');
    expect(reel?.aspectRatio).toBe('9:16');
    expect(story?.width).toBe(1080);
    expect(story?.height).toBe(1920);
    expect(post?.width).toBe(post?.height);
  });
});
