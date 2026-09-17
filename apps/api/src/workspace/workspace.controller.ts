import { Body, Controller, Get, Patch } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { WorkspaceService } from './workspace.service';

class UpdateTeamDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  niche?: string;
}

// email is deliberately not here — it's the identity Supabase Auth issued
// the session for (User.supabaseId), and changing it here would desync
// this row from what the user actually logs in with. A real email change
// has to go through supabase.auth.updateUser() client-side (which re-
// verifies the new address), not this API.
class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatarUrl?: string;
}

@Controller('workspace')
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Get('billing')
  billing(@CurrentUser() user: AuthenticatedUser) {
    return this.workspace.billing(user);
  }

  @Get('team')
  team(@CurrentUser() user: AuthenticatedUser) {
    return this.workspace.team(user);
  }

  @Patch('team')
  updateTeam(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateTeamDto,
  ) {
    return this.workspace.updateTeam(user, body);
  }

  @Get('profile')
  profile(@CurrentUser() user: AuthenticatedUser) {
    return this.workspace.profile(user);
  }

  @Patch('profile')
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateProfileDto,
  ) {
    return this.workspace.updateProfile(user, body);
  }

  @Get('integrations')
  integrations() {
    return this.workspace.integrations();
  }
}
