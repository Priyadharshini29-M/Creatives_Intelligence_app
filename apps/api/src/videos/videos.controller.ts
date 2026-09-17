import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AssignVariantDto } from './dto/assign-variant.dto';
import { CreateUploadDto } from './dto/create-upload.dto';
import { ListVideosDto } from './dto/list-videos.dto';
import { RecordApprovalDto } from './dto/record-approval.dto';
import { RecordOutcomeDto } from './dto/record-outcome.dto';
import { VideosService } from './videos.service';

@Controller('videos')
export class VideosController {
  constructor(private readonly videos: VideosService) {}

  @Post('upload-url')
  createUpload(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateUploadDto,
  ) {
    return this.videos.createUpload(user, dto);
  }

  @Post(':id/complete')
  completeUpload(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.videos.completeUpload(user, id);
  }

  @Post(':id/reanalyze')
  reanalyze(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.videos.reanalyze(user, id);
  }

  @Patch(':id/variant')
  assignVariant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AssignVariantDto,
  ) {
    return this.videos.assignVariant(user, id, dto);
  }

  @Patch(':id/outcome')
  recordOutcome(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RecordOutcomeDto,
  ) {
    return this.videos.recordOutcome(user, id, dto);
  }

  @Patch(':id/approval')
  recordApproval(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RecordApprovalDto,
  ) {
    return this.videos.recordApproval(user, id, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListVideosDto) {
    return this.videos.list(user, query);
  }

  @Get(':id')
  getById(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.videos.getById(user, id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.videos.remove(user, id);
  }
}
