"""Upload each published forecast pair, and Taipei's week table, to the
deployed site.

Downstream of publishing, which is downstream of collection: nothing here may
block the collection loop, raise into it, or log the secret. See
docs/superpowers/specs/2026-09-14-deployment-design.md §5 and
docs/superpowers/specs/2026-09-16-stage-a-any-time-arrival-design.md §4.

The week table is a third, independent artifact on its own daily cadence, not
a third blob riding `send_pair`'s five-minute request: `send_week` is its own
PUT, to its own path, with its own `UploadGuard` inside `Uploader` -- see
`send_week` and `Uploader._attempt_week`.
"""
import hashlib
import logging
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from parkcast import artifacts, config

log = logging.getLogger("parkcast.upload")

SECRET_RE = re.compile(r"pcu_[A-Za-z0-9_-]{43}")
UPLOAD_PATH = "/artifacts/latest"
KNOWN_REJECTS = frozenset({"future", "too-old", "stale", "too-soon", "roster-shrink"})
SendResult = tuple[int, str | None, str | None]


def new_secret() -> str:
    """`pcu_` + 32 random bytes as unpadded base64url (43 characters)."""
    return "pcu_" + secrets.token_urlsafe(32)


def load_secret(path: Path) -> str | None:
    """The secret, or None. Never logs the file's contents."""
    try:
        value = Path(path).read_text(encoding="utf-8-sig").strip()
    except (OSError, ValueError):
        return None
    return value if SECRET_RE.fullmatch(value) else None


def upload_url(env: Mapping[str, str]) -> str | None:
    """The configured endpoint, only if it is exactly the pinned HTTPS URL."""
    raw = env.get(config.UPLOAD_URL_ENV, "")
    if not raw or "REPLACE" in config.UPLOAD_HOST:
        return None
    try:
        parts = urlsplit(raw)
        bad = (parts.scheme != "https" or parts.hostname != config.UPLOAD_HOST or parts.port is not None
               or parts.username or parts.password or parts.path != UPLOAD_PATH
               or parts.query or parts.fragment)
    except ValueError:
        return None
    return None if bad else raw


class UploadGuard:
    """Decides whether to attempt an upload, so no failure mode becomes a loop."""

    def __init__(self, *, clock: Callable[[], float] = time.time,
                 daily_cap: int = config.UPLOAD_DAILY_CAP,
                 max_skip_ticks: int = config.UPLOAD_MAX_SKIP_TICKS,
                 auth_retry_sec: int = config.UPLOAD_AUTH_RETRY_SEC,
                 limit_probe_sec: int = config.UPLOAD_LIMIT_PROBE_SEC):
        self._clock = clock
        self._daily_cap = daily_cap
        self._max_skip = max_skip_ticks
        self._auth_retry_sec = auth_retry_sec
        self._limit_probe_sec = limit_probe_sec
        self._last_done: object = None
        self._day = None
        self._attempts = 0
        self._skip = 0
        self._backoff = 0
        self._paused_until = 0.0

    def should_attempt(self, key: object) -> tuple[bool, str]:
        now = self._clock()
        if key == self._last_done:
            return False, "duplicate"
        day = datetime.fromtimestamp(now, config.TAIPEI_TZ).date()
        if day != self._day:
            self._day, self._attempts = day, 0
        if now < self._paused_until:
            return False, "paused"
        if self._skip > 0:
            self._skip -= 1
            return False, "backing off"
        if self._attempts >= self._daily_cap:
            return False, "daily cap reached"
        self._attempts += 1
        return True, ""

    def record(self, key: object, status: int | None) -> None:
        now = self._clock()
        if status in (204, 409):
            self._last_done, self._backoff, self._skip = key, 0, 0
        elif status == 401:
            self._paused_until = now + self._auth_retry_sec
        elif status == 429:
            # Provisional match for the daily Worker limit; Task 13 confirms the
            # exact response and tightens this.
            tomorrow = datetime.fromtimestamp(now, timezone.utc) + timedelta(days=1)
            midnight = tomorrow.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
            self._paused_until = min(now + self._limit_probe_sec, midnight)
        else:
            self._backoff = min(max(1, self._backoff * 2), self._max_skip)
            self._skip = self._backoff


class _RefuseRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused", headers, fp)


def build_opener() -> urllib.request.OpenerDirector:
    """No proxies from the environment, no redirects, certificate checks on."""
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        _RefuseRedirect(),
        urllib.request.HTTPSHandler(),
    )


def send_pair(url: str, secret: str, grid: bytes, lots: bytes, *,
              opener: urllib.request.OpenerDirector, timeout: float) -> SendResult:
    request = urllib.request.Request(url, data=grid + lots, method="PUT")
    request.add_header("Content-Type", "application/octet-stream")
    request.add_header("X-Grid-Length", str(len(grid)))
    request.add_header("User-Agent", config.UPLOAD_USER_AGENT)
    request.add_unredirected_header("Authorization", f"Bearer {secret}")
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, response.headers.get("X-Reject"), response.headers.get("Date")
    except urllib.error.HTTPError as err:
        try:
            headers = err.headers
            return err.code, headers.get("X-Reject") if headers else None, headers.get("Date") if headers else None
        finally:
            err.close()


def _week_target(url: str, city: str) -> str:
    """The week table's own endpoint, beside the pair's on the same host.

    `url` is the pinned pair endpoint (`.../artifacts/latest`); the week table
    is a third, independent artifact (see `artifacts.py`'s module docstring),
    so it gets its own path rather than riding `/artifacts/latest` -- built
    from the same per-city filename convention `grid_name`/`lots_name` already
    use (`artifacts.week_name`), so another city needs no new routing here.
    """
    parts = urlsplit(url)
    path = f"/artifacts/{artifacts.week_name(city)}"
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


def send_week(url: str, secret: str, week: bytes, *, city: str, roster_id: int,
              opener: urllib.request.OpenerDirector, timeout: float) -> SendResult:
    """PUT one city's week table. Its own request -- never `send_pair`'s.

    The pair rides one endpoint because it is one upload of two concatenated
    blobs; the week table is a separate artifact on a separate, much slower
    cadence (see `artifacts.publish_week`), so it needs its own PUT rather
    than a third blob spliced onto `send_pair`'s body. `X-Roster-Id` lets the
    Worker refuse a roster it does not recognise from the header alone, the
    same reason `send_pair` sends `X-Grid-Length` -- without first parsing
    ~700 KB of body to find out.

    Same response shape, same redirect refusal and the same never-forward-the-
    secret behaviour as `send_pair`, because both are policy that must not
    drift between the two artifacts, not detail this function owns.
    """
    request = urllib.request.Request(_week_target(url, city), data=week, method="PUT")
    request.add_header("Content-Type", "application/octet-stream")
    request.add_header("X-Roster-Id", str(roster_id))
    request.add_header("User-Agent", config.UPLOAD_USER_AGENT)
    request.add_unredirected_header("Authorization", f"Bearer {secret}")
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, response.headers.get("X-Reject"), response.headers.get("Date")
    except urllib.error.HTTPError as err:
        try:
            headers = err.headers
            return err.code, headers.get("X-Reject") if headers else None, headers.get("Date") if headers else None
        finally:
            err.close()


@dataclass(frozen=True, slots=True)
class _Job:
    grid: bytes
    lots: bytes
    key: tuple[int, int, str]


@dataclass(frozen=True, slots=True)
class _WeekJob:
    week: bytes
    city: str
    roster_id: int
    key: tuple[str, int, str]


class Uploader:
    """One daemon thread. One waiting pair job and one waiting week job at
    most, each attempted independently -- see `offer` and `offer_week`."""

    def __init__(self, url: str, secret: str, *, send: Callable[..., SendResult] = send_pair,
                 send_week: Callable[..., SendResult] = send_week,
                 guard: UploadGuard | None = None, week_guard: UploadGuard | None = None,
                 opener=None,
                 deadline_sec: float = config.UPLOAD_DEADLINE_SEC,
                 timeout_sec: float = config.UPLOAD_TIMEOUT_SEC,
                 clock: Callable[[], float] = time.time):
        self._url = url
        self._secret = secret
        self._send = send
        self._send_week = send_week
        self._guard = guard or UploadGuard(clock=clock)
        # A week upload is downstream of the corpus's daily cadence, not the
        # pair's five-minute one: its own back-off state, so a run of failed
        # pair attempts cannot pause the week table, and a bad week response
        # (say, a stray 401) cannot pause the pair -- they share nothing but
        # the opener, the user agent and the skew check below.
        self._week_guard = week_guard or UploadGuard(clock=clock)
        self._opener = opener or build_opener()
        self._deadline = deadline_sec
        self._timeout = timeout_sec
        self._clock = clock
        self._cond = threading.Condition()
        self._pending: _Job | None = None
        self._pending_week: _WeekJob | None = None
        self._helper: threading.Thread | None = None
        self._helper_week: threading.Thread | None = None
        self._skew_logged = False

    def start(self) -> "Uploader":
        threading.Thread(target=self._loop, name="parkcast-upload", daemon=True).start()
        return self

    def offer(self, grid: bytes, lots: bytes, *, base_data_ts: int, roster_id: int) -> None:
        key = (base_data_ts, roster_id, hashlib.sha256(grid + lots).hexdigest())
        with self._cond:
            self._pending = _Job(grid, lots, key)
            self._cond.notify()

    def offer_week(self, week: bytes, *, city: str, roster_id: int) -> None:
        """Queue one city's week table. Never blocks, exactly like `offer`."""
        key = (city, roster_id, hashlib.sha256(week).hexdigest())
        with self._cond:
            self._pending_week = _WeekJob(week, city, roster_id, key)
            self._cond.notify()

    def process_pending(self) -> bool:
        with self._cond:
            job, self._pending = self._pending, None
        if job is None:
            return False
        self._attempt(job)
        return True

    def process_pending_week(self) -> bool:
        with self._cond:
            job, self._pending_week = self._pending_week, None
        if job is None:
            return False
        self._attempt_week(job)
        return True

    def _loop(self) -> None:
        while True:
            with self._cond:
                while self._pending is None and self._pending_week is None:
                    self._cond.wait()
            # Independent jobs, independent failures: one raising (should
            # neither ever do, but see the `except Exception` nets inside
            # each `_attempt*`) must not stop the other from being tried this
            # pass through the loop.
            try:
                self.process_pending()
            except Exception as exc:  # never let the thread die
                log.warning("upload thread error: %s", type(exc).__name__)
            try:
                self.process_pending_week()
            except Exception as exc:
                log.warning("upload thread error: %s", type(exc).__name__)

    def _attempt(self, job: _Job) -> None:
        if self._helper is not None and self._helper.is_alive():
            log.warning("upload skipped: previous attempt still running")
            return
        ok, reason = self._guard.should_attempt(job.key)
        if not ok:
            if reason != "duplicate":
                log.info("upload skipped: %s", reason)
            return
        total_bytes = len(job.grid) + len(job.lots)
        box: dict = {}

        def run() -> None:
            started = time.monotonic()
            try:
                box["result"] = self._send(self._url, self._secret, job.grid, job.lots,
                                           opener=self._opener, timeout=self._timeout)
            except Exception as exc:
                box["error"] = type(exc).__name__
            box["seconds"] = time.monotonic() - started

        self._helper = threading.Thread(target=run, name="parkcast-upload-send", daemon=True)
        self._helper.start()
        self._helper.join(self._deadline)
        if self._helper.is_alive():
            log.warning("upload abandoned after %ss (bytes=%s)", self._deadline, total_bytes)
            self._guard.record(job.key, None)
            return
        if "error" in box:
            log.warning("upload failed: %s (duration=%.1fs bytes=%s)",
                        box["error"], box["seconds"], total_bytes)
            self._guard.record(job.key, None)
            return
        status, reject, date_header = box["result"]
        self._guard.record(job.key, status)
        self._check_skew(date_header)
        if status == 204:
            log.info("uploaded: status=204 bytes=%s duration=%.1fs", total_bytes, box["seconds"])
        elif status == 409 and reject in ("stale", "too-soon"):
            log.info("upload not needed: status=409 reject=%s duration=%.1fs bytes=%s",
                     reject, box["seconds"], total_bytes)
        elif status == 409:
            # The Worker refused the reading itself. An unknown token is never
            # logged as sent: it is text from the network.
            token = reject if reject in KNOWN_REJECTS else "unknown"
            log.warning("upload rejected: %s status=409 duration=%.1fs bytes=%s",
                        token, box["seconds"], total_bytes)
        elif status == 401:
            log.warning("upload unauthorized: status=401 duration=%.1fs bytes=%s; retrying in an hour",
                       box["seconds"], total_bytes)
        elif status == 429:
            log.warning("upload refused: status=429 duration=%.1fs bytes=%s; pausing",
                       box["seconds"], total_bytes)
        else:
            log.warning("upload failed: status=%s duration=%.1fs bytes=%s",
                       status, box["seconds"], total_bytes)

    def _attempt_week(self, job: _WeekJob) -> None:
        """`_attempt`'s week counterpart: its own request (`send_week`, never
        `send_pair`), its own guard (`_week_guard`, never `_guard`), its own
        in-flight thread (`_helper_week`, never `_helper`) -- so a week upload
        can never be skipped as "previous attempt still running" because a
        pair attempt is in flight, or vice versa. Reuses `_opener` and
        `_check_skew` because those are shared policy, not per-job state.
        """
        if self._helper_week is not None and self._helper_week.is_alive():
            log.warning("week upload skipped: previous attempt still running")
            return
        ok, reason = self._week_guard.should_attempt(job.key)
        if not ok:
            if reason != "duplicate":
                log.info("week upload skipped: %s", reason)
            return
        total_bytes = len(job.week)
        box: dict = {}

        def run() -> None:
            started = time.monotonic()
            try:
                box["result"] = self._send_week(self._url, self._secret, job.week,
                                                city=job.city, roster_id=job.roster_id,
                                                opener=self._opener, timeout=self._timeout)
            except Exception as exc:
                box["error"] = type(exc).__name__
            box["seconds"] = time.monotonic() - started

        self._helper_week = threading.Thread(
            target=run, name="parkcast-upload-week-send", daemon=True
        )
        self._helper_week.start()
        self._helper_week.join(self._deadline)
        if self._helper_week.is_alive():
            log.warning("week upload abandoned after %ss (bytes=%s)", self._deadline, total_bytes)
            self._week_guard.record(job.key, None)
            return
        if "error" in box:
            log.warning("week upload failed: %s (duration=%.1fs bytes=%s)",
                        box["error"], box["seconds"], total_bytes)
            self._week_guard.record(job.key, None)
            return
        status, reject, date_header = box["result"]
        self._week_guard.record(job.key, status)
        self._check_skew(date_header)
        if status == 204:
            log.info("week uploaded: status=204 bytes=%s duration=%.1fs", total_bytes, box["seconds"])
        elif status == 409 and reject in ("stale", "too-soon"):
            log.info("week upload not needed: status=409 reject=%s duration=%.1fs bytes=%s",
                     reject, box["seconds"], total_bytes)
        elif status == 409:
            token = reject if reject in KNOWN_REJECTS else "unknown"
            log.warning("week upload rejected: %s status=409 duration=%.1fs bytes=%s",
                        token, box["seconds"], total_bytes)
        elif status == 401:
            log.warning("week upload unauthorized: status=401 duration=%.1fs bytes=%s; "
                       "retrying in an hour", box["seconds"], total_bytes)
        elif status == 429:
            log.warning("week upload refused: status=429 duration=%.1fs bytes=%s; pausing",
                       box["seconds"], total_bytes)
        else:
            log.warning("week upload failed: status=%s duration=%.1fs bytes=%s",
                       status, box["seconds"], total_bytes)

    def _check_skew(self, date_header: str | None) -> None:
        if not date_header or self._skew_logged:
            return
        try:
            skew = abs(parsedate_to_datetime(date_header).timestamp() - self._clock())
        except (TypeError, ValueError):
            return
        if skew > 60:
            self._skew_logged = True
            log.warning("container clock differs from the server by %ss", round(skew))


def from_environment(env: Mapping[str, str] = os.environ,
                     secret_path: Path = config.UPLOAD_SECRET_PATH) -> Uploader | None:
    try:
        url = upload_url(env)
        secret = load_secret(secret_path)
        if url is None or secret is None:
            log.info("uploads disabled (%s)", "no valid upload URL" if url is None else "no valid secret file")
            return None
        return Uploader(url, secret).start()
    except Exception as exc:
        # Last line of defence: nothing here may crash the collector. Never
        # log the exception's message -- it may embed the secret (see the
        # constructed RuntimeError in the tests).
        log.info("uploads disabled (%s)", type(exc).__name__)
        return None
