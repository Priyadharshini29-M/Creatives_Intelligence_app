import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreateVariantGroupDto } from './dto/create-variant-group.dto';
import { VariantGroupsService } from './variant-groups.service';

@Controller('variant-groups')
export class VariantGroupsController {
  constructor(private readonly variantGroups: VariantGroupsService) {}

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateVariantGroupDto) {
    return this.variantGroups.create(user, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.variantGroups.list(user);
  }

  @Get(':id')
  getById(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.variantGroups.getById(user, id);
  }
}
