import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsInt, IsOptional, IsUrl, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreativeService } from './creative.service';

class AnalyzeLandingDto {
  @IsUrl({ require_protocol: true })
  url!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  seed?: number;
}

class BriefQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  seed?: number;
}

@Controller('videos/:id/creative')
export class CreativeController {
  constructor(private readonly creative: CreativeService) {}

  @Get()
  brief(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query() query: BriefQueryDto,
  ) {
    return this.creative.brief(user, id, query.seed ?? 1);
  }

  @Post('landing-page')
  landingPage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: AnalyzeLandingDto,
  ) {
    return this.creative.landingPage(user, id, body.url, body.seed ?? 1);
  }
}
