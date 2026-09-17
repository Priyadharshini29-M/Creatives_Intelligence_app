import { Controller, Get } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { TrainingService } from './training.service';

@Controller('training')
export class TrainingController {
  constructor(private readonly training: TrainingService) {}

  @Get('export-dataset')
  exportDataset(@CurrentUser() user: AuthenticatedUser) {
    return this.training.exportDataset(user);
  }
}
