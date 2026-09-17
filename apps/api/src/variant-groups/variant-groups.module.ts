import { Module } from '@nestjs/common';
import { VariantGroupsController } from './variant-groups.controller';
import { VariantGroupsService } from './variant-groups.service';

@Module({
  controllers: [VariantGroupsController],
  providers: [VariantGroupsService],
  exports: [VariantGroupsService],
})
export class VariantGroupsModule {}
