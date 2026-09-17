from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Auth service configuration. Values come from apps/auth/.env or the shell.

    This service has exactly one job: verify a Supabase-issued access token
    and hand back the identity it encodes, so the NestJS API can authenticate
    a request the same way it used to call @clerk/backend's verifyToken()
    inline. Supabase itself still owns sign-up/sign-in/session-issuance (the
    frontend talks to Supabase directly via @supabase/supabase-js) — this
    service never sees a password and never mints a token, it only checks one.
    """

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: str = "development"
    port: int = 8001

    # Legacy HS256 shared-secret path — only still relevant for a token
    # signed before this project rotated to JWT Signing Keys (see
    # supabase_url below); newly issued tokens use ES256 and verify via
    # JWKS instead, which needs no secret at all. Left supported as a
    # fallback since Supabase keeps a rotated-out HS256 key valid until any
    # tokens it signed actually expire.
    supabase_jwt_secret: str = ""
    # Project URL — also the base for the public JWKS endpoint
    # (`{supabase_url}/auth/v1/.well-known/jwks.json`) that ES256 tokens
    # verify against. This is a public key fetch, no secret required; PyJWT's
    # PyJWKClient fetches and caches it (keyed by `kid` in the token header,
    # so key rotation just adds a cache entry rather than needing a restart).
    supabase_url: str = ""


settings = Settings()
