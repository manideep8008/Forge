"""Shared authentication helpers for internal service-to-service calls."""
from __future__ import annotations

import os
import secrets
from collections.abc import Awaitable, Callable

from fastapi import Request
from fastapi.responses import JSONResponse, Response

INTERNAL_API_KEY = os.environ["INTERNAL_API_KEY"]
INTERNAL_API_KEY_HEADER = "X-Internal-API-Key"
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
}


def internal_api_headers() -> dict[str, str]:
    return {INTERNAL_API_KEY_HEADER: INTERNAL_API_KEY}


def add_security_headers(response: Response) -> Response:
    for header, value in SECURITY_HEADERS.items():
        response.headers.setdefault(header, value)
    return response


async def require_internal_api_key(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    provided = request.headers.get(INTERNAL_API_KEY_HEADER, "")
    if not secrets.compare_digest(provided, INTERNAL_API_KEY):
        return add_security_headers(JSONResponse(
            {"detail": "internal service authentication required"},
            status_code=401,
        ))
    return add_security_headers(await call_next(request))
