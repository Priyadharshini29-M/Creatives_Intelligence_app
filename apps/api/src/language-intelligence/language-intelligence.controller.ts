import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { CheckCopyQualityDto } from './dto/check-copy-quality.dto';
import { LanguageIntelligenceService } from './language-intelligence.service';

@Controller('videos/:id')
export class LanguageIntelligenceController {
  constructor(private readonly service: LanguageIntelligenceService) {}

  @Get('copy-quality')
  getCopyQuality(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.service.getCopyQualityCheck(user, id);
  }

  @Post('copy-quality')
  checkCopyQuality(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: CheckCopyQualityDto,
  ) {
    return this.service.checkCopyQuality(user, id, body);
  }

  @Get('regional-fit')
  getRegionalFit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.service.getRegionalFit(user, id);
  }

  @Post('regional-fit')
  analyzeRegionalFit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.service.analyzeRegionalFit(user, id);
  }
}
