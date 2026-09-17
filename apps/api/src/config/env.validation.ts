import { z } from 'zod';

// z.coerce.boolean() runs JS's `Boolean(value)` on the raw env STRING —
// `Boolean("false")` is `true` (any non-empty string is truthy), so setting
// e.g. `AUTH_DEV_BYPASS=false` in .env silently left dev bypass ON. Only
// ever noticed because AUTH_DEV_BYPASS had always been left unset or "true"
// before now — the same bug was latent on S3_FORCE_PATH_STYLE too, just
// never triggered since that one's only ever been set to "true". Parses the
// actual string content instead of coercing it.
function zBoolEnv(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return defaultValue;
      return ['true', '1', 'yes'].includes(v.trim().toLowerCase());
    });
}

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().default(4000),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),

  // S3-compatible storage (MinIO locally, AWS S3 in production)
  S3_ENDPOINT: z.string().optional(),
  // Browser-reachable endpoint used in presigned URLs. Keep S3_ENDPOINT as
  // the server/container endpoint when those differ.
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET_VIDEOS: z.string().default('videos'),
  S3_FORCE_PATH_STYLE: zBoolEnv(true),

  // Auth — Supabase issues sessions directly to the frontend; this API only
  // verifies them, via the Python auth service below. Dev bypass available
  // locally (never in production — see supabase-auth.guard.ts).
  AUTH_DEV_BYPASS: zBoolEnv(false),

  // Python AI service
  AI_SERVICE_URL: z.string().default('http://localhost:8000'),
  // Python auth service — verifies Supabase access tokens (see apps/auth).
  AUTH_SERVICE_URL: z.string().default('http://localhost:8001'),

  // Creative Intelligence pipeline data directory — rules.json, video-record
  // JSON+thumbnail snapshots, and PDF/JSON exports all live under here (see
  // apps/api/src/rules and apps/api/src/exports). Not the prototype code
  // that may also live under this path — just pipeline output/config data.
  CREATIVE_INTELLIGENCE_DATA_DIR: z
    .string()
    .default('D:\\Creative-Intelligence'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment configuration:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  // Unlike Clerk's secret key (held here, with no safe default), the JWT
  // secret this now depends on lives only in apps/auth — there's nothing
  // sensitive for this service to validate at startup. AUTH_SERVICE_URL
  // always resolves (it defaults to localhost:8001); if the auth service
  // itself is unreachable, that surfaces at request time as a 401 via
  // AuthClientService, not as a startup config error.
  return parsed.data;
}
