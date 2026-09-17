import { Module } from '@nestjs/common';
import { CreativeController } from './creative.controller';
import { CreativeService } from './creative.service';

@Module({
  controllers: [CreativeController],
  providers: [CreativeService],
})
export class CreativeModule {}
