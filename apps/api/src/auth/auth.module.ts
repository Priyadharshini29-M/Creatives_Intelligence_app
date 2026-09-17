import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthClientService } from './auth-client.service';
import { SupabaseAuthGuard } from './supabase-auth.guard';
import { UsersService } from './users.service';

@Global()
@Module({
  providers: [
    UsersService,
    AuthClientService,
    // Every route requires auth by default; opt out with @Public().
    { provide: APP_GUARD, useClass: SupabaseAuthGuard },
  ],
  exports: [UsersService],
})
export class AuthModule {}
