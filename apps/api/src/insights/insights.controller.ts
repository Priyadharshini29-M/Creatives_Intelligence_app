import { Controller, Get } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { InsightsService } from './insights.service';

@Controller('insights')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get('tribe')
  tribe(@CurrentUser() user: AuthenticatedUser) {
    return this.insights.tribe(user);
  }

  @Get('platforms')
  platforms(@CurrentUser() user: AuthenticatedUser) {
    return this.insights.platforms(user);
  }

  @Get('benchmarks')
  benchmarks(@CurrentUser() user: AuthenticatedUser) {
    return this.insights.benchmarks(user);
  }
}
