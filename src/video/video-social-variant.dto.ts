import type { SocialVariantKind } from './social-video.types';

export type SocialVariantResponseDto = {
  kind: SocialVariantKind;
  label: string;
  aspectRatio: string;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  downloadUrl: string | null;
};

export type SocialVariantDoc = {
  kind: SocialVariantKind;
  label: string;
  aspectRatio: string;
  videoKey: string;
  thumbnailKey: string;
  durationSec?: number;
};

export async function mapSocialVariantsForResponse(
  variants: SocialVariantDoc[] | undefined | null,
  presign: (key: string) => Promise<string>,
  options: { includeDownloads: boolean; includePlayback: boolean },
): Promise<SocialVariantResponseDto[]> {
  const list = variants ?? [];
  const out: SocialVariantResponseDto[] = [];
  for (const v of list) {
    if (!v.videoKey?.trim() || !v.thumbnailKey?.trim()) continue;
    const videoUrl = options.includePlayback
      ? await presign(v.videoKey)
      : null;
    const thumbnailUrl = await presign(v.thumbnailKey);
    const downloadUrl = options.includeDownloads
      ? await presign(v.videoKey)
      : null;
    out.push({
      kind: v.kind,
      label: v.label,
      aspectRatio: v.aspectRatio,
      videoUrl,
      thumbnailUrl,
      downloadUrl,
    });
  }
  return out;
}
