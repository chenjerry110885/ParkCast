"""Shared HTTP transport for per-city source adapters.

Every feed request refuses redirects, honours a declared `Content-Length`
over the cap, and caps the streamed body -- the same safety behaviour
`collector.fetch_json` already has. `_read` holds that behaviour once so
`get_json` and `post_json` cannot drift apart from each other; a later task
moves Taipei's collector onto `get_json` too.
"""
import json

import requests

from parkcast import config
from parkcast.collector import FeedError

# Cloudflare and New Taipei's IIS both reject an anonymous default user
# agent; this is the same honest name `upload.py` already sends.
USER_AGENT = "parkcast-collector/1"


def _read(response, max_bytes: int) -> bytes:
    """Read one response body, refusing redirects and oversized bodies.

    Verbatim copy of the body-reading logic in `collector.fetch_json`: a
    redirect is never legitimate for these feeds, and the size cap bounds
    memory against a body that never ends.
    """
    if response.is_redirect or 300 <= response.status_code < 400:
        raise FeedError(f"refusing a redirect from the feed (HTTP {response.status_code})")
    response.raise_for_status()
    declared = response.headers.get("Content-Length")
    if declared is not None and declared.isdigit() and int(declared) > max_bytes:
        raise FeedError(f"feed body of {declared} bytes exceeds {max_bytes}")
    body = bytearray()
    for chunk in response.iter_content(chunk_size=64 * 1024):
        body += chunk
        if len(body) > max_bytes:
            raise FeedError(f"feed body exceeds {max_bytes} bytes")
    return bytes(body)


def get_json(url: str, *, timeout: int = config.HTTP_TIMEOUT_SEC,
             max_bytes: int = config.MAX_FEED_BYTES) -> object:
    """GET one feed blob as JSON, refusing redirects and oversized bodies."""
    headers = {"User-Agent": USER_AGENT}
    with requests.get(url, timeout=timeout, allow_redirects=False, stream=True,
                       headers=headers) as response:
        body = _read(response, max_bytes)
    return json.loads(body)


def post_json(url: str, *, body: bytes = b"", content_type: str | None = None,
              timeout: int = config.HTTP_TIMEOUT_SEC,
              max_bytes: int = config.MAX_FEED_BYTES) -> object:
    """POST one feed blob as JSON, refusing redirects and oversized bodies.

    Always sends an explicit `Content-Length`, even for an empty body: New
    Taipei's IIS answers 411 Length Required to a POST that omits one.
    """
    headers = {"User-Agent": USER_AGENT, "Content-Length": str(len(body))}
    if content_type is not None:
        headers["Content-Type"] = content_type
    with requests.post(url, data=body, timeout=timeout, allow_redirects=False, stream=True,
                        headers=headers) as response:
        response_body = _read(response, max_bytes)
    return json.loads(response_body)
