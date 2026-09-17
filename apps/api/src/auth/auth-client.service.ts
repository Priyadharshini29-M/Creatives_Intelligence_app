import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.validation';

export interface VerifiedIdentity {
  sub: string;
  email: string | null;
  role: string | null;
}

/** Thin client for the Python auth service's one job — verifying a Supabase
 * access token. Same call shape as apps/api/src/jobs/ai-client.service.ts's
 * plain-fetch pattern for the AI service, just a one-endpoint client. */
@Injectable()
export class AuthClientService {
  private readonly logger = new Logger(AuthClientService.name);
  private readonly baseUrl: string;

  constructor(config: ConfigService<Env, true>) {
    this.baseUrl = config.get('AUTH_SERVICE_URL', { infer: true });
  }

  /** Returns the verified identity, or null if the token is missing/invalid/
   * expired — the guard decides what to do with that (401), this client
   * just reports what the auth service said. */
  async verify(token: string): Promise<VerifiedIdentity | null> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    } catch (err) {
      this.logger.error(`Auth service unreachable: ${(err as Error).message}`);
      return null;
    }

    if (!res.ok) return null;
    return (await res.json()) as VerifiedIdentity;
  }
}
