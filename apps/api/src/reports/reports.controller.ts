import { Controller, Get, Param } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { ReportsService } from './reports.service';

@Controller('videos/:id/report')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  getReport(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.reports.getReport(user, id);
  }
}
