"""Shared HTTP transport for per-city source adapters.

Every feed request refuses redirects, honours a declared `Content-Length`
over the cap, and caps the streamed body. `_read` holds that behaviour once
so `get_json` and `post_json` cannot drift apart from each other -- and
`collector.fetch_json` (Taipei's own transport) delegates to `get_json` too,
so there is exactly one copy of this logic in the whole codebase.

TLS IS PER SOURCE, AND STRICT UNLESS A SOURCE SAYS OTHERWISE. Three of the
six feeds could not be verified at all from inside the collector image, for
two different reasons, and the fix for each is scoped to that one source by
`TlsPolicy` -- see the class docstring for what each knob does and what was
measured. Nothing here can turn verification off: there is no `verify=False`
path, no `CERT_NONE`, and no `check_hostname = False`, and a source that
passes no `tls=` argument reaches `requests` exactly as it did before this
existed.
"""
import json
import ssl
from dataclasses import dataclass
from pathlib import Path

import certifi
import requests

from parkcast import config

# The intermediate `www.parkinginfo.ntpc.gov.tw` does not send. Its own header
# block carries the full provenance and the chain proof; the short version is
# that it adds no new trust anchor -- its issuer, "TWCA CYBER Root CA", is
# already a trusted root in certifi.
TWCA_SSL_CA = Path(__file__).with_name("twca-ssl-ca-2023.pem")

# Cloudflare and New Taipei's IIS both reject an anonymous default user
# agent; this is the same honest name `upload.py` already sends.
USER_AGENT = "parkcast-collector/1"


class FeedError(RuntimeError):
    """The feed answered with something we refuse to read.

    Lives here, not in `collector.py`: `collector.fetch_json` delegates to
    this module's `get_json`, and `collector.FeedError` is only a re-export
    kept for backward compatibility with existing callers and tests.
    """


@dataclass(frozen=True, slots=True)
class TlsPolicy:
    """How one source's server certificate is verified.

    Frozen and compared by value, so `tls == STRICT` is a cheap, honest test
    for "this source asked for nothing special" and so a policy can never be
    mutated out from under a request already in flight.

    THE DEFAULT IS FULLY STRICT, AND IS WHAT EVERY UNDECLARED SOURCE GETS.
    Both fields default to the strict answer, so a relaxation is reachable
    only by a source spelling it out at its own call site. There is
    deliberately no module-level switch, no environment variable and no
    "relax everything" shortcut: a global knob is exactly the mistake this
    type exists to make impossible, because it would silently relax the
    three feeds that verify cleanly today along with the three that do not.

    `x509_strict=False` clears **only** `ssl.VERIFY_X509_STRICT`, nothing
    else. Hostname checking stays on, `verify_mode` stays `CERT_REQUIRED`,
    and the chain must still build to a trusted root. Python 3.13 turned
    that flag on by default in `ssl.create_default_context()`; it enforces
    RFC 5280 formalities that browsers and curl do not, and the one that
    bites here is "a CA certificate MUST carry a Subject Key Identifier".
    Measured in-container 2026-09-17: the certificate missing that extension
    is **certifi's own `TWCA Global Root CA`** -- the trust anchor, not
    anything either city server sends. Every certificate either server
    presents does carry an SKI. So this is an encoding gap in a
    2010-vintage root that Mozilla still ships, surfaced by a new default;
    clearing the flag drops a formality, not a security property.
    Signatures, validity dates, basic constraints, key usage, hostname and
    the path to a trusted root are all still checked.

    `extra_ca_file` is loaded **in addition to** certifi's bundle, never
    instead of it: `tls_context` loads certifi first and the extra file
    second, into the same store.
    """

    # Keep `ssl.VERIFY_X509_STRICT`. Only Kaohsiung and Hsinchu set False.
    x509_strict: bool = True
    # An extra CA file, loaded alongside certifi's. Only New Taipei sets it.
    extra_ca_file: Path | None = None


# What a source that declares nothing gets: `requests`' own defaults, which on
# this image are `ssl.create_default_context()` with `VERIFY_X509_STRICT` set
# (measured 2026-09-17 -- urllib3 2.8.0's `create_urllib3_context()` sets the
# flag, which is why Kaohsiung and Hsinchu failed in the first place). A policy
# equal to this one takes the untouched `requests.get`/`requests.post` path in
# `_fetch`, so the feeds that already verify are not touched by any of this.
STRICT = TlsPolicy()


def tls_context(policy: TlsPolicy) -> ssl.SSLContext:
    """One `SSLContext` for `policy`. The only place verification is configured.

    Starts from `ssl.create_default_context()` every time -- hostname
    checking and `CERT_REQUIRED` therefore come from Python's hardened
    default and are never assigned here -- and then applies at most the two
    narrow changes a policy can ask for. Reading this function is the whole
    audit: if it does not weaken something, nothing does.

    Built fresh per request rather than cached. Each build loads certifi's
    roots, which costs single-digit milliseconds once per source per
    five-minute tick, and in exchange there is no long-lived mutable trust
    store for a later edit to change quietly under a running collector.
    """
    context = ssl.create_default_context(cafile=certifi.where())
    if not policy.x509_strict:
        # `&= ~FLAG` clears exactly this bit, leaving every other verify flag
        # (CRL checking, partial chains, ...) as Python set it.
        context.verify_flags &= ~ssl.VERIFY_X509_STRICT
    if policy.extra_ca_file is not None:
        # Additive: certifi's roots are already loaded above and stay loaded.
        # A missing or malformed file raises right here, which is the loud
        # failure that quietly continuing without the intermediate would not
        # be -- the fetch would then fail anyway, but blaming the feed.
        context.load_verify_locations(cafile=str(policy.extra_ca_file))
    return context


class _ContextAdapter(requests.adapters.HTTPAdapter):
    """A `requests` adapter that pins one `SSLContext` onto its pools.

    `requests` has no per-request way to supply a context, so a source with a
    policy gets its own short-lived `Session` with this mounted.
    `HTTPAdapter.__init__` calls `init_poolmanager`, so the context has to be
    on `self` before `super().__init__` runs.
    """

    def __init__(self, context: ssl.SSLContext, **kwargs):
        self._context = context
        super().__init__(**kwargs)

    def init_poolmanager(self, *args, **kwargs):
        kwargs["ssl_context"] = self._context
        return super().init_poolmanager(*args, **kwargs)

    def proxy_manager_for(self, *args, **kwargs):
        kwargs["ssl_context"] = self._context
        return super().proxy_manager_for(*args, **kwargs)


def _fetch(method: str, url: str, *, tls: TlsPolicy, max_bytes: int, **kwargs) -> bytes:
    """One request body, read under `tls`.

    `STRICT` takes the plain `requests.get`/`requests.post` path this module
    has always used -- unchanged, so the three healthy feeds and Taipei's
    metadata fetch keep the exact transport they were proven on, and the
    existing tests that patch `requests.get`/`requests.post` keep patching
    the thing that is actually called.

    Anything else gets a `Session` with `_ContextAdapter` mounted. The body is
    read fully inside the `with`, before the session is closed: closing a
    session tears down its connection pool, and `stream=True` means the body
    may not have arrived yet.
    """
    if tls == STRICT:
        with getattr(requests, method)(url, **kwargs) as response:
            return _read(response, max_bytes)
    session = requests.Session()
    try:
        session.mount("https://", _ContextAdapter(tls_context(tls)))
        with session.request(method, url, **kwargs) as response:
            return _read(response, max_bytes)
    finally:
        session.close()


def _read(response, max_bytes: int) -> bytes:
    """Read one response body, refusing redirects and oversized bodies.

    A redirect is never legitimate for these feeds: both feed URLs answer
    200 directly, so following one would let a hijacked endpoint send this
    container's requests anywhere, including the local network. The size cap
    bounds memory against a body that never ends.
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
             max_bytes: int = config.MAX_FEED_BYTES,
             tls: TlsPolicy = STRICT) -> object:
    """GET one feed blob as JSON, refusing redirects and oversized bodies.

    `tls` defaults to `STRICT`: a caller that says nothing is verified
    exactly as it was before per-source policies existed.
    """
    headers = {"User-Agent": USER_AGENT}
    body = _fetch("get", url, tls=tls, max_bytes=max_bytes, timeout=timeout,
                  allow_redirects=False, stream=True, headers=headers)
    return json.loads(body)


def post_json(url: str, *, body: bytes = b"", content_type: str | None = None,
              timeout: int = config.HTTP_TIMEOUT_SEC,
              max_bytes: int = config.MAX_FEED_BYTES,
              tls: TlsPolicy = STRICT) -> object:
    """POST one feed blob as JSON, refusing redirects and oversized bodies.

    Always sends an explicit `Content-Length`, even for an empty body: New
    Taipei's IIS answers 411 Length Required to a POST that omits one.

    `tls` defaults to `STRICT`, as in `get_json`.
    """
    headers = {"User-Agent": USER_AGENT, "Content-Length": str(len(body))}
    if content_type is not None:
        headers["Content-Type"] = content_type
    response_body = _fetch("post", url, tls=tls, max_bytes=max_bytes, data=body,
                           timeout=timeout, allow_redirects=False, stream=True,
                           headers=headers)
    return json.loads(response_body)
