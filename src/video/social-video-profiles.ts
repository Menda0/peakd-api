import type { SocialVideoProfile } from './social-video.types';

/** Platform-safe raster targets for social exports (H.264 MP4). */
export const SOCIAL_VIDEO_PROFILES: readonly SocialVideoProfile[] = [
  {
    kind: 'reel',
    label: 'Reel',
    aspectRatio: '9:16',
    width: 1080,
    height: 1920,
    outputBasename: 'social-reel.mp4',
  },
  {
    kind: 'story',
    label: 'Story',
    aspectRatio: '9:16',
    width: 1080,
    height: 1920,
    outputBasename: 'social-story.mp4',
  },
  {
    kind: 'post',
    label: 'Post',
    aspectRatio: '1:1',
    width: 1080,
    height: 1080,
    outputBasename: 'social-post.mp4',
  },
] as const;
