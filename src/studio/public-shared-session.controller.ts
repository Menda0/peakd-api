import { Controller, Get, Param, StreamableFile } from '@nestjs/common';
import { SharedSessionService } from './shared-session.service';

@Controller('public/shared-sessions')
export class PublicSharedSessionController {
  constructor(private readonly sharedSession: SharedSessionService) {}

  @Get(':shareToken/export/download')
  async getProcessedExportDownload(
    @Param('shareToken') shareToken: string,
  ): Promise<StreamableFile> {
    const opened =
      await this.sharedSession.openPublicProcessedExportDownload(shareToken);
    return new StreamableFile(opened.stream, {
      type: opened.contentType,
      disposition: `attachment; filename="${opened.filename}"`,
      ...(opened.contentLength != null ? { length: opened.contentLength } : {}),
    });
  }

  @Get(':shareToken')
  getSharedSession(@Param('shareToken') shareToken: string) {
    return this.sharedSession.getPublicSharedSession(shareToken);
  }
}
