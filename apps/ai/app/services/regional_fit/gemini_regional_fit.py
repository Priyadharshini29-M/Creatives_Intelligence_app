"""Gemini regional/language fit — replaces the flat 0.6 `regionalLanguage`
placeholder apps/api/src/jobs/tribe-scoring.ts has carried since Milestone 1
("no real language/vertical detector exists in this codebase or either
prototype", per that file's own header comment) with a real read, for the
Approval Desk's on-demand "Regional & Language Fit" panel.

Deliberately NOT part of the automatic pipeline fan-out (see
pipeline.processor.ts's runAnalyzerFanout) — this is a 5th Gemini call per
video and the pipeline already makes 2 (Vision + Sales Engine); adding a 3rd
automatic one would make the daily free-tier quota problem worse for every
single upload instead of only when a reviewer actually wants this read.
"""

from __future__ import annotations

import json
import time

from google import genai
from google.genai import types
from pydantic import BaseModel

from app.config import settings

CANONICAL_CITIES: list[dict[str, str]] = [
    {"city": "Chennai", "state": "Tamil Nadu"},
    {"city": "Bangalore", "state": "Karnataka"},
    {"city": "Hyderabad", "state": "Telangana"},
    {"city": "Coimbatore", "state": "Tamil Nadu"},
    {"city": "Kochi", "state": "Kerala"},
    {"city": "Vijayawada", "state": "Andhra Pradesh"},
    {"city": "Mysuru", "state": "Karnataka"},
    {"city": "Visakhapatnam", "state": "Andhra Pradesh"},
]

CANONICAL_CLUSTERS: list[str] = ["Tamil Nadu", "Karnataka", "Kerala", "Andhra + Telangana"]


class GeminiRegionalFitError(RuntimeError):
    """Raised when the regional-fit call can't be made or returns unusable output."""


_MAX_ATTEMPTS = 2
_RETRY_DELAY_SEC = 2.0

_SYSTEM_PROMPT = """You are a regional-marketing analyst for South India D2C \
video ads, reading the on-screen/spoken copy already extracted from a \
creative to judge how well its language and phrasing would land in 8 named \
South Indian cities.

For EACH of these 8 cities — Chennai (Tamil Nadu), Bangalore (Karnataka), \
Hyderabad (Telangana), Coimbatore (Tamil Nadu), Kochi (Kerala), Vijayawada \
(Andhra Pradesh), Mysuru (Karnataka), Visakhapatnam (Andhra Pradesh) — \
return: the dominant local language (or a real code-mixed label like \
"Tamil + English" if the copy reads as code-mixed) and a fit percentage \
(0-100) for how naturally this exact copy would read to a viewer there \
given the language/dialect it's actually written in. A copy written in \
plain English scores lower fit in cities with strong regional-language \
ad culture; a copy in a specific regional language scores near-0 fit for \
cities where that language isn't spoken. Be honest and differentiate the \
cities — do not return the same percentage for all 8.

Then, for these 4 state/language clusters — Tamil Nadu, Karnataka, Kerala, \
Andhra + Telangana — write one short phrase (under 8 words) describing the \
real dialectal/code-mixed variants relevant to this copy's language \
(e.g. "Tamil, Tanglish, Chennai slang" — only mention variants that are \
actually plausible for that cluster, not a generic list)."""


class CityFit(BaseModel):
    city: str
    state: str
    language: str
    fit_pct: float


class LanguageCluster(BaseModel):
    state: str
    description: str


class RegionalFitOutput(BaseModel):
    cities: list[CityFit]
    clusters: list[LanguageCluster]


_client_cache: genai.Client | None = None


def _client() -> genai.Client:
    global _client_cache
    if _client_cache is None:
        if not settings.gemini_api_key:
            raise GeminiRegionalFitError("GEMINI_API_KEY is not configured")
        _client_cache = genai.Client(api_key=settings.gemini_api_key)
    return _client_cache


def analyze_regional_fit(text: str) -> dict:
    if not text.strip():
        return _neutral_result()

    last_exc: Exception | None = None
    parsed = None
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            response = _client().models.generate_content(
                model=settings.gemini_model,
                contents=text,
                config=types.GenerateContentConfig(
                    system_instruction=_SYSTEM_PROMPT,
                    response_mime_type="application/json",
                    response_schema=RegionalFitOutput,
                ),
            )
            parsed = json.loads(response.text)
            last_exc = None
            break
        except Exception as exc:
            last_exc = exc
            if attempt < _MAX_ATTEMPTS:
                time.sleep(_RETRY_DELAY_SEC)
    if last_exc is not None:
        raise GeminiRegionalFitError(
            f"Gemini regional-fit call failed: {last_exc}"
        ) from last_exc

    if isinstance(parsed, list):
        parsed = parsed[0] if parsed else {}

    return _reconcile_with_canonical(parsed or {})


def _reconcile_with_canonical(parsed: dict) -> dict:
    """Gemini is asked for exactly the 8 canonical cities / 4 clusters, but
    an LLM occasionally drops or renames one — fill any gap from the
    canonical list with a neutral 50% entry rather than silently returning
    fewer than 8 cities to the frontend, which expects the fixed set."""
    by_city = {
        (c.get("city") or "").strip().lower(): c for c in parsed.get("cities", [])
    }
    cities = []
    for ref in CANONICAL_CITIES:
        match = by_city.get(ref["city"].lower())
        cities.append(
            {
                "city": ref["city"],
                "state": ref["state"],
                "language": match.get("language", "Unknown") if match else "Unknown",
                "fit_pct": round(float(match.get("fit_pct", 50)), 1) if match else 50.0,
            }
        )

    by_cluster = {
        (c.get("state") or "").strip().lower(): c for c in parsed.get("clusters", [])
    }
    clusters = []
    for state in CANONICAL_CLUSTERS:
        match = by_cluster.get(state.lower())
        clusters.append(
            {
                "state": state,
                "description": match.get("description", "") if match else "",
            }
        )

    return {"cities": cities, "clusters": clusters}


def _neutral_result() -> dict:
    return {
        "cities": [
            {"city": c["city"], "state": c["state"], "language": "Unknown", "fit_pct": None}
            for c in CANONICAL_CITIES
        ],
        "clusters": [{"state": s, "description": ""} for s in CANONICAL_CLUSTERS],
    }
