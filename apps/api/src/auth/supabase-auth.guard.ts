import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Env } from '../config/env.validation';
import { AuthClientService } from './auth-client.service';
import { UsersService } from './users.service';
import { AuthenticatedUser } from './auth.types';
import { IS_PUBLIC_KEY } from './public.decorator';

// Every authenticated request previously paid, unconditionally: an HTTP
// round-trip to the Python auth service (JWT signature verification against
// Supabase's JWKS) + a Prisma `findUnique` against the database (now remote
// Supabase Postgres, not local MySQL — a real network hop, not free) — for
// the *same* still-valid token a user's browser sends on every click while
// they click around the app. Neither step's result changes between requests
// for the same token, so this is pure repeated work. Caching the resolved
// user per raw token for a short window skips both downstream calls on a
// cache hit — the single biggest lever on general app responsiveness that
// doesn't touch scoring/pipeline code at all.
//
// TTL is short (45s) and deliberately NOT "cache for the token's full
// lifetime" — a revoked/signed-out session should stop working reasonably
// promptly, not stay silently authenticated for up to an hour. Bounded size
// (simple oldest-first eviction, relying on Map's insertion-order iteration)
// caps memory from Supabase's automatic token refresh cycling through many
// distinct token strings over a long-running dev/prod process.
const AUTH_CACHE_TTL_MS = 45_000;
const AUTH_CACHE_MAX_ENTRIES = 500;

interface CachedAuth {
  user: AuthenticatedUser;
  expiresAt: number;
}

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(SupabaseAuthGuard.name);
  private readonly cache = new Map<string, CachedAuth>();

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly authClient: AuthClientService,
    private readonly users: UsersService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();

    // Local development escape hatch — never enabled in production because
    // env validation requires AUTH_SERVICE_URL to actually resolve when the
    // bypass is off, and deploy configs must not set AUTH_DEV_BYPASS.
    if (this.config.get('AUTH_DEV_BYPASS', { infer: true })) {
      request.user = await this.users.resolveDevUser();
      return true;
    }

    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : undefined;
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const cached = this.cache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
      request.user = cached.user;
      return true;
    }

    const identity = await this.authClient.verify(token);
    if (!identity) {
      this.logger.debug('Token verification failed');
      this.cache.delete(token);
      throw new UnauthorizedException('Invalid or expired token');
    }

    const user = await this.users.resolveFromSupabaseUser(identity);
    request.user = user;
    this.cacheAuth(token, user);
    return true;
  }

  private cacheAuth(token: string, user: AuthenticatedUser): void {
    if (this.cache.size >= AUTH_CACHE_MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(token, { user, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
  }
}
