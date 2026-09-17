from functools import lru_cache
from typing import Optional

import jwt
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import settings

router = APIRouter(prefix="/v1/auth", tags=["auth"])


class VerifyRequest(BaseModel):
    token: str


class VerifyResponse(BaseModel):
    sub: str
    email: Optional[str] = None
    role: Optional[str] = None


@lru_cache(maxsize=1)
def _jwks_client() -> "jwt.PyJWKClient":
    # Cached once per process — PyJWKClient itself caches the fetched key
    # set (keyed by `kid`) and only re-fetches on a cache miss, so this
    # doesn't mean "fetch once and never see a rotated key"; it means "don't
    # rebuild the whole client object on every request".
    jwks_url = f"{settings.supabase_url}/auth/v1/.well-known/jwks.json"
    return jwt.PyJWKClient(jwks_url, cache_keys=True)


def _verify_es256(token: str) -> dict:
    """Current path: this project's JWT Signing Keys are ECC P-256 (ES256),
    verified against Supabase's public JWKS — no shared secret involved."""
    signing_key = _jwks_client().get_signing_key_from_jwt(token)
    return jwt.decode(
        token,
        signing_key.key,
        algorithms=["ES256"],
        audience="authenticated",
    )


def _verify_hs256(token: str) -> dict:
    """Fallback for a token signed before this project rotated to JWT
    Signing Keys — Supabase keeps the rotated-out HS256 key valid until
    tokens it signed actually expire, so this stays relevant for a while
    after a rotation, not indefinitely."""
    if not settings.supabase_jwt_secret:
        raise jwt.PyJWTError("no legacy HS256 secret configured")
    return jwt.decode(
        token,
        settings.supabase_jwt_secret,
        algorithms=["HS256"],
        audience="authenticated",
    )


@router.post("/verify", response_model=VerifyResponse)
async def verify(body: VerifyRequest) -> VerifyResponse:
    """Verify a Supabase access token and return the identity it encodes.

    Called by the NestJS API's SupabaseAuthGuard on every authenticated
    request — mirrors what @clerk/backend's verifyToken() used to do
    in-process, just moved here per the chosen split (Supabase issues
    sessions directly to the frontend; this service only verifies them for
    the backend).

    Tries ES256/JWKS first (this project's current signing method), falling
    back to the legacy HS256 shared secret only if that's configured and
    ES256 verification didn't work — covers a token signed just before a
    key rotation without needing to know in advance which method a given
    token used.
    """
    if not settings.supabase_url:
        raise HTTPException(
            status_code=500,
            detail="SUPABASE_URL is not configured on the auth service.",
        )

    claims: dict | None = None
    last_error: Exception | None = None
    for verifier in (_verify_es256, _verify_hs256):
        try:
            claims = verifier(body.token)
            break
        except jwt.PyJWTError as exc:
            last_error = exc

    if claims is None:
        raise HTTPException(
            status_code=401, detail=f"Invalid token: {last_error}"
        ) from last_error

    sub = claims.get("sub")
    if not sub:
        raise HTTPException(status_code=401, detail="Token has no subject")

    return VerifyResponse(
        sub=sub,
        email=claims.get("email"),
        role=claims.get("role"),
    )
