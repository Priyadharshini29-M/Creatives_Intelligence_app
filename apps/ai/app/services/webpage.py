"""Landing/product page analyzer for ad-relevance checks.

Fetches a URL server-side and extracts the conversion-relevant signals the
creative engine compares against a video's ad content. Stdlib only — no
extra HTTP or parser dependencies.
"""

import ipaddress
import re
import socket
import urllib.request
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import urlparse

FETCH_TIMEOUT_SEC = 15
MAX_BYTES = 2_000_000

CTA_PATTERNS = (
    "buy now", "add to cart", "shop now", "order now", "get started",
    "sign up", "subscribe", "checkout", "add to bag", "book now",
)
PRICE_RE = re.compile(r"(?:₹|rs\.?|\$|€|£|inr|usd)\s?\d[\d,.]*", re.IGNORECASE)


class PageFetchError(RuntimeError):
    pass


@dataclass
class _Extractor(HTMLParser):
    title: str = ""
    meta_description: str = ""
    h1: list[str] = field(default_factory=list)
    h2: list[str] = field(default_factory=list)
    image_count: int = 0
    text_parts: list[str] = field(default_factory=list)
    _current: str | None = None

    def __post_init__(self):
        super().__init__(convert_charrefs=True)

    def handle_starttag(self, tag, attrs):
        if tag in ("title", "h1", "h2"):
            self._current = tag
        elif tag == "img":
            self.image_count += 1
        elif tag == "meta":
            a = dict(attrs)
            if (a.get("name") or a.get("property", "")).lower() in (
                "description", "og:description",
            ) and a.get("content"):
                self.meta_description = self.meta_description or a["content"]
        elif tag in ("script", "style"):
            self._current = "skip"

    def handle_endtag(self, tag):
        if tag in ("title", "h1", "h2", "script", "style"):
            self._current = None

    def handle_data(self, data):
        text = data.strip()
        if not text or self._current == "skip":
            return
        if self._current == "title" and not self.title:
            self.title = text[:200]
        elif self._current == "h1":
            self.h1.append(text[:200])
        elif self._current == "h2":
            self.h2.append(text[:200])
        else:
            self.text_parts.append(text)


def _guard_url(url: str) -> None:
    """Basic SSRF guard: public http(s) hosts only."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise PageFetchError("Only public http(s) URLs are supported")
    try:
        infos = socket.getaddrinfo(parsed.hostname, None)
    except socket.gaierror as exc:
        raise PageFetchError(f"Could not resolve host: {parsed.hostname}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise PageFetchError("URL resolves to a private address")


def analyze_page(url: str, keywords: list[str]) -> dict:
    _guard_url(url)

    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; VideoIntelligenceBot/1.0)",
            "Accept": "text/html,application/xhtml+xml",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_SEC) as res:
            raw = res.read(MAX_BYTES)
            charset = res.headers.get_content_charset() or "utf-8"
    except Exception as exc:  # URLError, HTTPError, timeout
        raise PageFetchError(f"Could not fetch page: {exc}") from exc

    parser = _Extractor()
    try:
        parser.feed(raw.decode(charset, errors="replace"))
    except Exception as exc:
        raise PageFetchError(f"Could not parse page HTML: {exc}") from exc

    body_text = " ".join(parser.text_parts)[:200_000]
    haystack = " ".join(
        [parser.title, parser.meta_description, *parser.h1, *parser.h2, body_text]
    ).lower()

    wanted = [k.lower().strip() for k in keywords if k and len(k.strip()) >= 3]
    matched = sorted({k for k in wanted if k in haystack})
    missing = sorted(set(wanted) - set(matched))

    return {
        "url": url,
        "title": parser.title,
        "meta_description": parser.meta_description[:300],
        "h1": parser.h1[:5],
        "h2": parser.h2[:10],
        "image_count": parser.image_count,
        "has_price": bool(PRICE_RE.search(haystack)),
        "cta_found": [c for c in CTA_PATTERNS if c in haystack],
        "word_count": len(body_text.split()),
        "matched_keywords": matched,
        "missing_keywords": missing,
        "relevance": round(len(matched) / len(wanted), 4) if wanted else None,
    }
