import { BadRequestException, Controller, Get, Param, Query, StreamableFile } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { ExportsService } from './exports.service';

@Controller('videos/:id/export')
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Get()
  async export(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('format') format = 'json',
  ): Promise<StreamableFile> {
    if (format === 'pdf') {
      const { content } = await this.exports.exportPdf(user, id);
      return new StreamableFile(content, {
        type: 'application/pdf',
        disposition: `attachment; filename="${id}-report.pdf"`,
      });
    }
    if (format === 'json') {
      const { content } = await this.exports.exportJson(user, id);
      return new StreamableFile(content, {
        type: 'application/json',
        disposition: `attachment; filename="${id}-report.json"`,
      });
    }
    throw new BadRequestException('format must be "json" or "pdf"');
  }
}
