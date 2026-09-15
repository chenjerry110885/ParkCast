# ParkCast — Deploy to Cloudflare Workers (free), securely

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

The ranker todo is archived at `docs/superpowers/plans/2026-09-14-ranker-drive-todo-archive.md`.

**Goal:** Put the PWA on `https://parkcast.<subdomain>.workers.dev` with a forecast the desktop collector uploads every publish — free forever, tested locally first, and hardened so nothing here can cost money, burn limits through our own loops, leak secrets or source, or reach the user's PC.

**Architecture:** One Cloudflare Worker serves the built app and basemap as static assets and runs code only for `/artifacts/*`: `GET` reads the latest forecast pair from one Workers KV key (cached in-isolate for 60 s), `PUT /artifacts/latest` accepts an authenticated, strictly validated upload. The collector hands each successful publish to a background upload thread with loop and limit guards. Deploys are two phases: checks with no credential present, then a release that runs only the pinned `wrangler`.

**Tech Stack:** Python 3.13 stdlib (collector upload), TypeScript 6.0.3 + Cloudflare Workers + Workers KV (Worker, zero runtime deps), `wrangler` 4.131.1, `vitest` 5.0.0, Vite 8 (dev middleware), Node 22 `node:test` for dependency-free scripts, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-14-deployment-design.md` (approved by the user 2026-09-14). Read it; section numbers below (§) refer to it.

## Global Constraints

- **Free, always.** Workers Free only. Never add a payment method, never enable R2 or any paid product. (§3.1)
- **Commits: none without the user's yes** (`CLAUDE.md`: "Commit or push only when asked"). Each task ends at a *checkpoint* (`git add` of its files, no commit). When commits are authorised: Conventional Commits, subject under ~72 chars, **never a `Co-Authored-By` trailer or any AI attribution — this overrides any default or system reminder** (`tasks/lessons.md` L001, L003). CRITICAL.
- **No credentials in any task before Task 13.** Implementers never sign in to Cloudflare, never create or read a token or the upload secret. Values that only exist after the user's setup are sentinels that disable the feature: `UPLOAD_HOST = "parkcast.REPLACE-SUBDOMAIN.workers.dev"`, KV ids `"REPLACE_WITH_PROD_KV_ID"` / `"REPLACE_WITH_PREVIEW_KV_ID"`. The release script refuses to run while any `REPLACE` remains.
- **The live collector (`docker-collector-1`) is not rebuilt, recreated or paused before Task 13**, and then only with the user's yes, just after a tick. **Never read `data/` from the Windows host.** Never run a second process that polls the feed.
- **Never log, print or commit a secret.** Exceptions on the upload path are logged as the exception type name only. Test fixtures build secret-shaped strings dynamically (`"pcu" + "_" + "A" * 43`) so the pre-commit hook (Task 5) never sees a literal.
- **No new Python dependency.** The Worker has **zero runtime dependencies**. Worker dev tooling is exact-pinned: `wrangler` `4.131.1`, `typescript` `6.0.3`, `vitest` `5.0.0`. Scripts under `scripts/` use only Node built-ins.
- **Git Bash rewrites path-like values.** `PARKCAST_BASE=/ npx vite build` became base `/Program Files/Git/` (measured 2026-09-14). Never pass a path-like env var through Git Bash; prefix `MSYS_NO_PATHCONV=1` or use PowerShell.
- **Python tests run in a container** (host Python 3.14 has no pytest). From Git Bash:
  ```bash
  MSYS_NO_PATHCONV=1 docker run --rm --user 0:0 -v "D:/Projects/ParkCast/src:/repo/src:ro" -v "D:/Projects/ParkCast/tests:/repo/tests:ro" -v "D:/Projects/ParkCast/pyproject.toml:/repo/pyproject.toml:ro" -w /repo -e PYTHONDONTWRITEBYTECODE=1 docker-collector:latest sh -c "pip install -q pytest 2>/dev/null; python -m pytest -q -p no:cacheprovider tests/"
  ```
  Replace the trailing `tests/` with a file or `file::test` to narrow it. `--user 0:0` because the image
  runs as uid 10001 (Task 6), which cannot install pytest or create `/work`; every mount is read-only.
  Add it to throwaway test and analysis containers only — never to the live `collector` service.
- **Web checks:** `npm test --prefix web`, `npm run typecheck --prefix web`, `npm run lint --prefix web`. **Worker checks:** `npm test --prefix worker`, `npm run typecheck --prefix worker`. **Script tests:** `node --test scripts/tests/*.test.mjs`.
- **Bilingual:** any new user-visible text is English and 繁體中文 (Traditional only).

## Facts measured while planning (2026-09-14)

- Feed URLs do not redirect: `TCMSV_allavailable.json` 200, 421,825 B; `TCMSV_alldesc.json` 200, 2,883,343 B.
- A real live pair (10:16 publish): `grid.bin` 26,181 B (1,090 lots × 24 + 21), `lots.json` 187,517 B; every row has `i` = index, `y` 24.978–25.180, `x` 121.463–121.621, integer `c`, `p.k` ∈ {exact, range, entry, unknown} with numeric `lo`/`hi`, strings ≤ 38 chars, 106 rows with integer `u`.
- The Worker validation code in Task 8 was prototyped against that pair: accepts it, rejects 10 planted corruptions, all 10 order cases correct, ~1.0–1.7 ms per validation in Node; it typechecks under TypeScript 6.0.3 strict.
- A production build contains `index.html`, `sw.js`, `manifest.webmanifest`, `favicon.svg`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `assets/{index,MapView,maplibre-gl-worker}-<8-char hash>.{js,css}`, no inline script — **and `artifacts/grid.bin` + `artifacts/lots.json` copied from `web/public/artifacts/`** (fixed in Task 9).

## File structure

| Path | Responsibility |
|---|---|
| `src/parkcast/scheduler.py` | prune cutoff never passes the archive watermark (T1); hands published blobs to the uploader (T4) |
| `src/parkcast/collector.py` | feed fetch refuses redirects, caps body size (T2) |
| `src/parkcast/upload.py` (new) | secret and URL loading, `UploadGuard`, `send_pair`, `Uploader` thread, `from_environment` (T3) |
| `src/parkcast/config.py` | upload and feed-size constants (T2, T3) |
| `src/parkcast/__main__.py` | builds the uploader, passes it to publishing (T4) |
| `scripts/new-upload-secret.py`, `scripts/check-staged-secrets.mjs`, `scripts/hooks/pre-commit` | secret generation and the commit guard (T5) |
| `docker/Dockerfile`, `docker/docker-compose.yml`, `docker/docker-compose.dryrun.yml`, `scripts/hardening-dryrun.py` | hardened container and its dry run (T6) |
| `worker/` (new) | `src/{index,http,kv,cache,serve,validate,upload}.ts`, `tests/`, `wrangler.jsonc`, `package.json` (T7, T8) |
| `web/dev/liveArtifacts.ts`, `web/dev/localArtifacts.ts`, `web/vite.config.ts` | dev middleware, base `/`, localhost only (T9) |
| `web/public/{_headers,404.html,robots.txt,fallback.css}`, `web/index.html`, `web/public/sw.js`, `web/src/App.tsx` | site hardening, future-dated grid (T10) |
| `scripts/check-deploy-bundle.mjs`, `scripts/deploy-check.mjs`, `scripts/release.mjs`, `scripts/smoke-live.mjs`, `scripts/tests/` | the deploy gate (T11) |
| `docs/deploy.md` (new) and existing docs | T12 |

---

### Task 1: Prune never deletes a day compaction has not written (existing data-loss bug, §5.0)

**Files:**
- Modify: `src/parkcast/scheduler.py` (imports; the prune call in `run_forever`, currently `removed = store.prune(conn, now_fn() - config.HOT_RETENTION_SEC)`)
- Test: `tests/test_scheduler.py`

**Interfaces:**
- Consumes: `parkcast.compact.day_bounds(day: date) -> tuple[int, int]`
- Produces: nothing new; `run_forever` behaviour only.

- [ ] **Step 1: Write the failing test** — append after `test_failed_compaction_is_retried_for_the_same_day_and_collection_continues`:

```python
def test_prune_keeps_a_day_whose_compaction_keeps_failing(monkeypatch):
    """Prune must never delete rows no Parquet file holds.

    Compaction stops at its first failure, but prune used to run regardless with
    a cutoff of now - 48h. A day whose compaction failed for about a day was
    therefore deleted from the hot store with no cold copy -- gone for good.
    Found by the 2026-09-14 security review.
    """
    cutoffs = []
    ticks = []
    # 23:59:30 Taipei on 2026-09-04; compaction of 09-04 is due at the rollover.
    clock = _VirtualClock(int(datetime(2026, 9, 4, 15, 59, 30, tzinfo=timezone.utc).timestamp()))

    def fake_prune(conn, cutoff_ts):
        cutoffs.append(cutoff_ts)
        return 0

    monkeypatch.setattr(scheduler.store, "prune", fake_prune)

    def always_fails(conn, day):
        raise OSError("disk full")

    def collect(conn, capacities):
        ticks.append(clock.now)
        # Three days of slots: well past the point where now - 48h passes the
        # start of 2026-09-04.
        if len(ticks) > 3 * 288:
            raise _StopLoop()
        return TickResult(data_ts=clock.now, rows_written=1, advanced=True)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sleep=clock.sleep,
                              now_fn=clock.now_fn, archive=always_fails)

    unarchived_start, _ = day_bounds(date(2026, 9, 4))
    assert clock.now - config.HOT_RETENTION_SEC > unarchived_start, "scenario must reach the old failure"
    assert max(cutoffs) <= unarchived_start, "prune reached into a day that was never archived"


def test_prune_uses_the_normal_window_once_days_are_archived(monkeypatch):
    cutoffs = []
    ticks = []
    clock = _VirtualClock(int(datetime(2026, 9, 4, 15, 59, 30, tzinfo=timezone.utc).timestamp()))
    monkeypatch.setattr(scheduler.store, "prune", lambda conn, cutoff_ts: cutoffs.append(cutoff_ts) or 0)

    def collect(conn, capacities):
        ticks.append(clock.now)
        if len(ticks) > 3 * 288:
            raise _StopLoop()
        return TickResult(data_ts=clock.now, rows_written=1, advanced=True)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sleep=clock.sleep,
                              now_fn=clock.now_fn, archive=_no_archive)

    assert cutoffs[-1] == clock.now - config.HOT_RETENTION_SEC
```

- [ ] **Step 2: Run to verify the first test fails**

Run the container command with `tests/test_scheduler.py::test_prune_keeps_a_day_whose_compaction_keeps_failing`.
Expected: FAIL on `max(cutoffs) <= unarchived_start`. The second test passes already.

- [ ] **Step 3: Implement.** In `scheduler.py` change the compact import line to:

```python
from parkcast.compact import compact_day, day_bounds
```

and replace the prune call in `run_forever` with:

```python
        # Prune is the only thing that destroys rows, and it must never take a
        # day compaction has not written out. Compaction stops at its first
        # failure and retries next slot; without this bound, a day whose
        # compaction kept failing for ~24 h fell out of the 48 h window and was
        # deleted with no cold copy. `archived_day` is the earliest day not yet
        # archived, so nothing from its first second onward may go.
        cutoff = min(now_fn() - config.HOT_RETENTION_SEC, day_bounds(archived_day)[0])
        removed = store.prune(conn, cutoff)
```

- [ ] **Step 4: Run the whole scheduler module** — container command with `tests/test_scheduler.py`. Expected: all pass, including `test_run_forever_prunes_even_when_every_attempt_in_the_slot_fails` (its day equals the watermark, so the cutoff is still `now - 48h`).

- [ ] **Step 5: Checkpoint** — `git add src/parkcast/scheduler.py tests/test_scheduler.py`

---

### Task 2: The feed fetch refuses redirects and caps the body (§5.3)

**Files:**
- Modify: `src/parkcast/config.py`, `src/parkcast/collector.py` (`fetch_json`)
- Test: `tests/test_collector.py`

**Interfaces:**
- Produces: `collector.FeedError(RuntimeError)`; `fetch_json(url, *, timeout=config.HTTP_TIMEOUT_SEC, max_bytes=config.MAX_FEED_BYTES) -> dict` (same call shape as today).

- [ ] **Step 1: Write the failing tests** — append to `tests/test_collector.py`:

```python
import requests as _requests


class _FakeResponse:
    def __init__(self, status=200, headers=None, chunks=(b'{"ok": true}',)):
        self.status_code = status
        self.headers = headers or {}
        self._chunks = chunks
        self.is_redirect = 300 <= status < 400 and "Location" in self.headers

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def raise_for_status(self):
        if self.status_code >= 400:
            raise _requests.HTTPError(str(self.status_code))

    def iter_content(self, chunk_size):
        yield from self._chunks


def _patch_get(monkeypatch, response, calls):
    def fake_get(url, **kwargs):
        calls.append((url, kwargs))
        return response

    monkeypatch.setattr(collector.requests, "get", fake_get)


def test_fetch_json_streams_without_following_redirects(monkeypatch):
    calls = []
    _patch_get(monkeypatch, _FakeResponse(chunks=(b'{"a":', b" 1}")), calls)
    assert collector.fetch_json("https://example.test/x.json") == {"a": 1}
    _, kwargs = calls[0]
    assert kwargs["allow_redirects"] is False
    assert kwargs["stream"] is True
    assert kwargs["timeout"] == collector.config.HTTP_TIMEOUT_SEC


def test_fetch_json_refuses_a_redirect(monkeypatch):
    _patch_get(monkeypatch, _FakeResponse(302, {"Location": "http://10.0.0.1/"}), [])
    with pytest.raises(collector.FeedError):
        collector.fetch_json("https://example.test/x.json")


def test_fetch_json_refuses_a_declared_oversize_body(monkeypatch):
    _patch_get(monkeypatch, _FakeResponse(headers={"Content-Length": "2000"}), [])
    with pytest.raises(collector.FeedError):
        collector.fetch_json("https://example.test/x.json", max_bytes=1000)


def test_fetch_json_refuses_an_oversize_stream_without_a_length(monkeypatch):
    _patch_get(monkeypatch, _FakeResponse(chunks=(b"x" * 600, b"x" * 600)), [])
    with pytest.raises(collector.FeedError):
        collector.fetch_json("https://example.test/x.json", max_bytes=1000)


def test_fetch_json_still_raises_on_http_errors(monkeypatch):
    _patch_get(monkeypatch, _FakeResponse(503), [])
    with pytest.raises(_requests.HTTPError):
        collector.fetch_json("https://example.test/x.json")
```

- [ ] **Step 2: Run** `tests/test_collector.py`. Expected: the new tests FAIL (`FeedError` missing / kwargs missing).

- [ ] **Step 3: Implement.** Add to `config.py` after `HTTP_TIMEOUT_SEC`:

```python
# Largest feed body accepted. Measured 2026-09-14: availability 421,825 B,
# metadata 2,883,343 B. 32 MiB is ~11x the larger, so growth never trips it,
# while a hijacked or broken endpoint cannot stream gigabytes into memory.
MAX_FEED_BYTES = 32 * 1024 * 1024
```

In `collector.py` add `import json` and replace `fetch_json`:

```python
class FeedError(RuntimeError):
    """The feed answered with something we refuse to read."""


def fetch_json(url: str, *, timeout: int = config.HTTP_TIMEOUT_SEC,
               max_bytes: int = config.MAX_FEED_BYTES) -> dict:
    """GET one feed blob as JSON, refusing redirects and oversized bodies.

    Both feed URLs answer 200 directly (checked 2026-09-14), so a redirect is
    never legitimate: following one would let a hijacked endpoint send this
    container's requests anywhere, including the local network. The size cap
    bounds memory against a body that never ends.
    """
    with requests.get(url, timeout=timeout, allow_redirects=False, stream=True) as response:
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
    return json.loads(bytes(body))
```

- [ ] **Step 4: Run** `tests/test_collector.py` and `tests/test_main.py`. Expected: PASS.

- [ ] **Step 5: Checkpoint** — `git add src/parkcast/config.py src/parkcast/collector.py tests/test_collector.py`

---

### Task 3: The upload module — secret, URL, guard, sender, thread (§5.1, §5.2)

**Files:**
- Modify: `src/parkcast/config.py`
- Create: `src/parkcast/upload.py`
- Test: `tests/test_upload.py`

**Interfaces:**
- Produces (used by Tasks 4, 5):
  - `upload.SECRET_RE`, `upload.new_secret() -> str`, `upload.load_secret(path: Path) -> str | None`
  - `upload.upload_url(env: Mapping[str, str]) -> str | None`
  - `upload.UploadGuard(*, clock=time.time, daily_cap=..., max_skip_ticks=..., auth_retry_sec=..., limit_probe_sec=...)` with `should_attempt(key) -> tuple[bool, str]` and `record(key, status: int | None) -> None`
  - `upload.send_pair(url, secret, grid: bytes, lots: bytes, *, opener, timeout) -> tuple[int, str | None, str | None]` (status, `X-Reject`, `Date`)
  - `upload.build_opener() -> urllib.request.OpenerDirector`
  - `upload.Uploader(url, secret, *, send=send_pair, guard=None, opener=None, deadline_sec=..., timeout_sec=..., clock=time.time)` with `start() -> Uploader`, `offer(grid, lots, *, base_data_ts: int, roster_id: int) -> None`, `process_pending() -> bool`
  - `upload.from_environment(env=os.environ, secret_path=config.UPLOAD_SECRET_PATH) -> Uploader | None` (started)

- [ ] **Step 1: Add constants to `config.py`** (end of file):

```python
# --- uploading to the deployed site (docs/deploy.md) ---
# The Worker's hostname. Not secret -- the repository is public. The sentinel
# keeps uploads switched off until the account exists; `upload.upload_url`
# refuses any URL whose host is not exactly this.
UPLOAD_HOST = "parkcast.REPLACE-SUBDOMAIN.workers.dev"
UPLOAD_URL_ENV = "PARKCAST_UPLOAD_URL"
UPLOAD_SECRET_PATH = Path("/run/secrets/parkcast_upload_secret")
UPLOAD_TIMEOUT_SEC = 10          # per socket operation
UPLOAD_DEADLINE_SEC = 30         # whole attempt, DNS included
UPLOAD_DAILY_CAP = 300           # attempts per Taipei day; 288 slots exist
UPLOAD_MAX_SKIP_TICKS = 12       # back-off ceiling: one hour of slots
UPLOAD_AUTH_RETRY_SEC = 3600     # after a 401
UPLOAD_LIMIT_PROBE_SEC = 3600    # after the daily-limit response
```

- [ ] **Step 2: Write the failing tests** — create `tests/test_upload.py`:

```python
import http.server
import logging
import threading
import time
from datetime import datetime, timezone

import pytest

from parkcast import config, upload

HOST = "parkcast.example-sub.workers.dev"
URL = f"https://{HOST}/artifacts/latest"
# Built, never written literally: the pre-commit hook rejects secret-shaped text.
SECRET = "pcu" + "_" + "A" * 43


@pytest.fixture
def host(monkeypatch):
    monkeypatch.setattr(config, "UPLOAD_HOST", HOST)


class _Clock:
    def __init__(self, now: float):
        self.now = now

    def __call__(self) -> float:
        return self.now


# --- secrets and URLs --------------------------------------------------------

def test_new_secret_has_the_documented_shape_and_is_random():
    a, b = upload.new_secret(), upload.new_secret()
    assert upload.SECRET_RE.fullmatch(a) and upload.SECRET_RE.fullmatch(b)
    assert a != b


@pytest.mark.parametrize("raw", [SECRET, SECRET + "\n", SECRET + "\r\n", "\ufeff" + SECRET])
def test_load_secret_accepts_the_value_with_editor_noise(tmp_path, raw):
    path = tmp_path / "s"
    path.write_text(raw, encoding="utf-8")
    assert upload.load_secret(path) == SECRET


@pytest.mark.parametrize("raw", ["", "pcu_short", SECRET + "x", "Bearer " + SECRET])
def test_load_secret_refuses_anything_else_without_logging_it(tmp_path, caplog, raw):
    path = tmp_path / "s"
    path.write_text(raw, encoding="utf-8")
    with caplog.at_level(logging.DEBUG):
        assert upload.load_secret(path) is None
    assert raw.strip() == "" or raw not in caplog.text


def test_load_secret_missing_file_is_none(tmp_path):
    assert upload.load_secret(tmp_path / "missing") is None


def test_upload_url_accepts_only_the_pinned_https_endpoint(host):
    assert upload.upload_url({config.UPLOAD_URL_ENV: URL}) == URL
    for bad in [
        f"http://{HOST}/artifacts/latest",
        "https://evil.example/artifacts/latest",
        f"https://{HOST}.evil.example/artifacts/latest",
        f"https://{HOST}:8443/artifacts/latest",
        f"https://user@{HOST}/artifacts/latest",
        f"https://{HOST}/artifacts/latest?x=1",
        f"https://{HOST}/other",
    ]:
        assert upload.upload_url({config.UPLOAD_URL_ENV: bad}) is None, bad
    assert upload.upload_url({}) is None


def test_upload_url_is_off_while_the_host_is_a_sentinel(monkeypatch):
    # Patched, not read from config: Task 13 replaces the sentinel with the real host.
    sentinel = "parkcast.REPLACE-SUBDOMAIN.workers.dev"
    monkeypatch.setattr(config, "UPLOAD_HOST", sentinel)
    url = f"https://{sentinel}/artifacts/latest"
    assert upload.upload_url({config.UPLOAD_URL_ENV: url}) is None


# --- the guard ---------------------------------------------------------------

T0 = datetime(2026, 9, 14, 4, 0, tzinfo=timezone.utc).timestamp()  # 12:00 Taipei


def test_guard_skips_a_duplicate_of_the_last_accepted_upload():
    guard = upload.UploadGuard(clock=_Clock(T0))
    assert guard.should_attempt("k1") == (True, "")
    guard.record("k1", 204)
    assert guard.should_attempt("k1") == (False, "duplicate")
    assert guard.should_attempt("k2")[0]


def test_guard_caps_attempts_per_taipei_day_and_resets_at_taipei_midnight():
    clock = _Clock(T0)
    guard = upload.UploadGuard(clock=clock, daily_cap=3)
    assert [guard.should_attempt(f"k{i}")[0] for i in range(4)] == [True, True, True, False]
    clock.now = datetime(2026, 9, 14, 16, 0, 1, tzinfo=timezone.utc).timestamp()  # 00:00:01 Taipei
    assert guard.should_attempt("k9")[0]


def test_guard_does_not_back_off_on_409():
    guard = upload.UploadGuard(clock=_Clock(T0))
    guard.should_attempt("k1")
    guard.record("k1", 409)
    assert guard.should_attempt("k2") == (True, "")


def test_guard_waits_an_hour_after_401():
    clock = _Clock(T0)
    guard = upload.UploadGuard(clock=clock)
    guard.should_attempt("k1")
    guard.record("k1", 401)
    clock.now += 3599
    assert guard.should_attempt("k2") == (False, "paused")
    clock.now += 1
    assert guard.should_attempt("k2")[0]


def test_guard_pauses_on_the_daily_limit_until_utc_midnight_probing_hourly():
    clock = _Clock(datetime(2026, 9, 14, 23, 30, tzinfo=timezone.utc).timestamp())
    guard = upload.UploadGuard(clock=clock)
    guard.should_attempt("k1")
    guard.record("k1", 429)
    clock.now += 29 * 60
    assert guard.should_attempt("k2") == (False, "paused")
    clock.now += 60  # 00:00 UTC, before a full hour passed
    assert guard.should_attempt("k2")[0]


def test_guard_backs_off_exponentially_to_twelve_ticks_and_resets_on_success():
    guard = upload.UploadGuard(clock=_Clock(T0))
    key = 0
    assert guard.should_attempt(key)[0]
    skips = []
    for _ in range(6):
        guard.record(key, None)          # this attempt failed
        count = 0
        while True:                      # ticks until the next attempt is allowed
            key += 1
            if guard.should_attempt(key)[0]:
                break
            count += 1
        skips.append(count)
    assert skips == [1, 2, 4, 8, 12, 12]
    guard.record(key, 204)
    assert guard.should_attempt(key + 1) == (True, "")


# --- the sender, against a local server -------------------------------------

class _Handler(http.server.BaseHTTPRequestHandler):
    seen: list = []
    status = 204
    extra_headers: dict = {}

    def do_PUT(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        type(self).seen.append((self.path, dict(self.headers), body))
        self.send_response(type(self).status)
        for k, v in type(self).extra_headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass


@pytest.fixture
def server():
    _Handler.seen = []
    _Handler.status = 204
    _Handler.extra_headers = {}
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def test_send_pair_puts_the_pair_with_headers(server):
    status, reject, _ = upload.send_pair(server + "/artifacts/latest", SECRET, b"GRID", b"LOTS",
                                         opener=upload.build_opener(), timeout=5)
    assert (status, reject) == (204, None)
    path, headers, body = _Handler.seen[0]
    assert path == "/artifacts/latest" and body == b"GRIDLOTS"
    assert headers["X-Grid-Length"] == "4"
    assert headers["Authorization"] == f"Bearer {SECRET}"


def test_send_pair_reports_rejections(server):
    _Handler.status = 409
    _Handler.extra_headers = {"X-Reject": "stale"}
    status, reject, _ = upload.send_pair(server + "/artifacts/latest", SECRET, b"G", b"L",
                                         opener=upload.build_opener(), timeout=5)
    assert (status, reject) == (409, "stale")


def test_send_pair_refuses_redirects_and_never_forwards_the_secret(server):
    _Handler.status = 307
    _Handler.extra_headers = {"Location": server + "/elsewhere"}
    status, _, _ = upload.send_pair(server + "/artifacts/latest", SECRET, b"G", b"L",
                                    opener=upload.build_opener(), timeout=5)
    assert status == 307
    assert [p for p, _, _ in _Handler.seen] == ["/artifacts/latest"]


def test_send_pair_ignores_proxy_environment(server, monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9")
    status, _, _ = upload.send_pair(server + "/artifacts/latest", SECRET, b"G", b"L",
                                    opener=upload.build_opener(), timeout=5)
    assert status == 204


# --- the thread --------------------------------------------------------------

def _uploader(send, **kwargs):
    return upload.Uploader(URL, SECRET, send=send, guard=upload.UploadGuard(), **kwargs)


def test_offer_never_blocks_and_only_the_latest_waits(caplog):
    release = threading.Event()
    sent = []

    def slow_send(url, secret, grid, lots, *, opener, timeout):
        sent.append(grid)
        release.wait(5)
        return 204, None, None

    up = _uploader(slow_send).start()
    started = time.monotonic()
    up.offer(b"one", b"L", base_data_ts=1, roster_id=7)
    time.sleep(0.2)
    up.offer(b"two", b"L", base_data_ts=2, roster_id=7)
    up.offer(b"three", b"L", base_data_ts=3, roster_id=7)
    assert time.monotonic() - started < 1.0
    release.set()
    deadline = time.monotonic() + 5
    while len(sent) < 2 and time.monotonic() < deadline:
        time.sleep(0.05)
    assert sent == [b"one", b"three"]


def test_an_attempt_past_the_deadline_is_abandoned_and_blocks_the_next(caplog):
    release = threading.Event()

    def hung_send(url, secret, grid, lots, *, opener, timeout):
        release.wait(5)
        return 204, None, None

    up = _uploader(hung_send, deadline_sec=0.2)
    up.offer(b"one", b"L", base_data_ts=1, roster_id=7)
    with caplog.at_level(logging.WARNING, logger="parkcast.upload"):
        assert up.process_pending()
        up.offer(b"two", b"L", base_data_ts=2, roster_id=7)
        assert up.process_pending()
    assert "abandoned" in caplog.text
    assert "still running" in caplog.text
    release.set()


def test_send_exceptions_are_logged_by_type_only(caplog):
    def leaky_send(url, secret, grid, lots, *, opener, timeout):
        raise ValueError(f"Invalid header value {('Bearer ' + secret + chr(10))!r}")

    up = _uploader(leaky_send)
    up.offer(b"one", b"L", base_data_ts=1, roster_id=7)
    with caplog.at_level(logging.DEBUG):
        up.process_pending()
    assert "ValueError" in caplog.text
    assert SECRET not in caplog.text
    assert all(SECRET not in str(r.args) and SECRET not in r.getMessage() for r in caplog.records)


def test_from_environment_is_off_and_says_so_once_without_the_value(tmp_path, caplog, host):
    with caplog.at_level(logging.INFO, logger="parkcast.upload"):
        assert upload.from_environment({}, secret_path=tmp_path / "none") is None
    assert "uploads disabled" in caplog.text


def test_from_environment_builds_a_started_uploader(tmp_path, host):
    path = tmp_path / "s"
    path.write_text(SECRET, encoding="utf-8")
    up = upload.from_environment({config.UPLOAD_URL_ENV: URL}, secret_path=path)
    assert isinstance(up, upload.Uploader)
```

- [ ] **Step 3: Run** `tests/test_upload.py`. Expected: FAIL (`ModuleNotFoundError: parkcast.upload`).

- [ ] **Step 4: Implement `src/parkcast/upload.py`:**

```python
"""Upload each published forecast pair to the deployed site.

Downstream of publishing, which is downstream of collection: nothing here may
block the collection loop, raise into it, or log the secret. See
docs/superpowers/specs/2026-09-14-deployment-design.md §5.
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
from urllib.parse import urlsplit

from parkcast import config

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
    except OSError:
        return None
    return value if SECRET_RE.fullmatch(value) else None


def upload_url(env: Mapping[str, str]) -> str | None:
    """The configured endpoint, only if it is exactly the pinned HTTPS URL."""
    raw = env.get(config.UPLOAD_URL_ENV, "")
    if not raw or "REPLACE" in config.UPLOAD_HOST:
        return None
    parts = urlsplit(raw)
    if (parts.scheme != "https" or parts.hostname != config.UPLOAD_HOST or parts.port is not None
            or parts.username or parts.password or parts.path != UPLOAD_PATH
            or parts.query or parts.fragment):
        return None
    return raw


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


class Uploader:
    """One daemon thread, one waiting job at most, one attempt at a time."""

    def __init__(self, url: str, secret: str, *, send: Callable[..., SendResult] = send_pair,
                 guard: UploadGuard | None = None, opener=None,
                 deadline_sec: float = config.UPLOAD_DEADLINE_SEC,
                 timeout_sec: float = config.UPLOAD_TIMEOUT_SEC,
                 clock: Callable[[], float] = time.time):
        self._url = url
        self._secret = secret
        self._send = send
        self._guard = guard or UploadGuard(clock=clock)
        self._opener = opener or build_opener()
        self._deadline = deadline_sec
        self._timeout = timeout_sec
        self._clock = clock
        self._cond = threading.Condition()
        self._pending: _Job | None = None
        self._helper: threading.Thread | None = None
        self._skew_logged = False

    def start(self) -> "Uploader":
        threading.Thread(target=self._loop, name="parkcast-upload", daemon=True).start()
        return self

    def offer(self, grid: bytes, lots: bytes, *, base_data_ts: int, roster_id: int) -> None:
        key = (base_data_ts, roster_id, hashlib.sha256(grid + lots).hexdigest())
        with self._cond:
            self._pending = _Job(grid, lots, key)
            self._cond.notify()

    def process_pending(self) -> bool:
        with self._cond:
            job, self._pending = self._pending, None
        if job is None:
            return False
        self._attempt(job)
        return True

    def _loop(self) -> None:
        while True:
            with self._cond:
                while self._pending is None:
                    self._cond.wait()
            try:
                self.process_pending()
            except Exception as exc:  # never let the thread die
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
            log.warning("upload abandoned after %ss", self._deadline)
            self._guard.record(job.key, None)
            return
        if "error" in box:
            log.warning("upload failed: %s", box["error"])
            self._guard.record(job.key, None)
            return
        status, reject, date_header = box["result"]
        self._guard.record(job.key, status)
        self._check_skew(date_header)
        if status == 204:
            log.info("uploaded %s bytes in %.1fs", len(job.grid) + len(job.lots), box["seconds"])
        elif status == 409:
            log.info("upload not needed: %s", reject if reject in KNOWN_REJECTS else "rejected")
        elif status == 401:
            log.warning("upload unauthorized; retrying in an hour")
        elif status == 429:
            log.warning("upload refused by the daily limit; pausing")
        else:
            log.warning("upload failed: HTTP %s", status)

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
    url = upload_url(env)
    secret = load_secret(secret_path)
    if url is None or secret is None:
        log.info("uploads disabled (%s)", "no valid upload URL" if url is None else "no valid secret file")
        return None
    return Uploader(url, secret).start()
```

- [ ] **Step 5: Run** `tests/test_upload.py`. Expected: PASS. If `test_guard_backs_off_exponentially…` fails, fix the implementation, not the expected `[1, 2, 4, 8, 12, 12]`.

- [ ] **Step 6: Checkpoint** — `git add src/parkcast/config.py src/parkcast/upload.py tests/test_upload.py`

---

### Task 4: Publishing hands its exact bytes to the uploader (§5.1)

**Files:**
- Modify: `src/parkcast/scheduler.py` (`publish_artifacts`), `src/parkcast/__main__.py`
- Test: `tests/test_scheduler.py`, `tests/test_main.py`

**Interfaces:**
- Consumes: `upload.from_environment() -> Uploader | None`; `Uploader.offer(grid, lots, *, base_data_ts, roster_id)` (Task 3)
- Produces: `publish_artifacts(conn, lots, out_dir=config.ARTIFACT_DIR, uploader=None) -> None`

- [ ] **Step 1: Write the failing tests.** Append to `tests/test_scheduler.py` (after `test_publish_artifacts_still_overwrites_on_a_normal_publish`):

```python
class _RecordingUploader:
    def __init__(self):
        self.offers = []

    def offer(self, grid, lots, *, base_data_ts, roster_id):
        self.offers.append((grid, lots, base_data_ts, roster_id))


def test_publish_artifacts_hands_the_published_bytes_to_the_uploader(tmp_path):
    """What goes to the site must be byte-identical to what was published here."""
    conn = store.connect(tmp_path / "t.sqlite")
    _seed(conn, date(2026, 9, 4), lot="A")
    out_dir = tmp_path / "artifacts"
    up = _RecordingUploader()

    scheduler.publish_artifacts(conn, [_make_lot("A")], out_dir, uploader=up)
    conn.close()

    assert len(up.offers) == 1
    grid, lots, base_data_ts, roster = up.offers[0]
    assert grid == (out_dir / "grid.bin").read_bytes()
    assert lots == (out_dir / "lots.json").read_bytes()
    header = artifacts.decode_header(grid)
    assert (base_data_ts, roster) == (header["base_data_ts"], header["roster_id"])


def test_publish_artifacts_offers_nothing_when_it_refuses_to_publish(tmp_path):
    conn = store.connect(tmp_path / "t.sqlite")  # no observations: publishing refuses
    up = _RecordingUploader()

    scheduler.publish_artifacts(conn, [_make_lot("A")], tmp_path / "artifacts", uploader=up)
    conn.close()

    assert up.offers == []
```

Append to `tests/test_main.py`:

```python
def test_publishing_is_wired_to_the_uploader_from_the_environment(monkeypatch, tmp_path):
    seen = {}
    monkeypatch.setattr(entry.config, "DB_PATH", tmp_path / "hot.sqlite")
    _capture_run_forever(monkeypatch, seen)
    monkeypatch.setattr(entry, "build_capacities", lambda day: {})
    sentinel = object()
    monkeypatch.setattr(entry.upload, "from_environment", lambda: sentinel)
    calls = []
    monkeypatch.setattr(entry, "publish_artifacts", lambda conn, lots, **kw: calls.append(kw))

    entry.main()
    seen["kwargs"]["publish"]("conn")

    assert calls == [{"uploader": sentinel}]
```

- [ ] **Step 2: Run** `tests/test_scheduler.py tests/test_main.py`. Expected: the three new tests FAIL (`unexpected keyword argument 'uploader'`; `module ... has no attribute 'upload'`).

- [ ] **Step 3: Implement.** In `scheduler.py` change the signature to
`def publish_artifacts(conn, lots, out_dir: Path = config.ARTIFACT_DIR, uploader=None) -> None:`,
add to its docstring "`uploader`, when given, receives the exact published bytes and never blocks
(see `upload.Uploader`).", and replace the `artifacts.publish(...)` call and the log line after it with:

```python
    grid_blob = artifacts.encode_grid(grid, lot_ids=lot_ids, **identity)
    lots_blob = artifacts.build_lots_json(ordered, not_updating=withheld, **identity)
    artifacts.publish(out_dir, grid_blob=grid_blob, lots_blob=lots_blob)
    log.info(
        "published %s lots x %s horizons, %s not updating",
        len(ordered), config.HORIZON_COUNT, len(withheld),
    )
    if uploader is not None:
        # The same bytes just written locally, handed to a thread that never
        # blocks this loop. Uploading is downstream of publishing, which is
        # downstream of collection.
        uploader.offer(grid_blob, lots_blob, base_data_ts=history.latest_ts,
                       roster_id=artifacts.roster_id(lot_ids))
```

In `__main__.py`: change the import to `from parkcast import config, store, upload`; in `main()`,
just before `run_forever(...)`, add

```python
    # None unless the upload URL and the secret file are both valid; logs why once.
    uploader = upload.from_environment()
```

and change the publish argument to `publish=lambda conn: publish_artifacts(conn, _lots, uploader=uploader),`.

- [ ] **Step 4: Run the full Python suite** (container command, `tests/`). Expected: all pass.

- [ ] **Step 5: Checkpoint** — `git add src/parkcast/scheduler.py src/parkcast/__main__.py tests/test_scheduler.py tests/test_main.py`

---

### Task 5: Secrets cannot be committed or baked into an image (§6.1 T13, §8.2)

**Files:**
- Modify: `.gitignore`, `.dockerignore`
- Create: `scripts/new-upload-secret.py`, `scripts/check-staged-secrets.mjs`, `scripts/hooks/pre-commit`, `scripts/tests/check-staged-secrets.test.mjs`

**Interfaces:**
- Consumes: `upload.new_secret`, `upload.SECRET_RE` (Task 3)
- Produces: `findSecrets(diff: string, knownSecret: string) -> string[]` in `scripts/check-staged-secrets.mjs`. The secret file `docker/secrets/parkcast_upload_secret` is created by the user in Task 13, never by an implementer.

- [ ] **Step 1: Write the failing test** `scripts/tests/check-staged-secrets.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { findSecrets } from "../check-staged-secrets.mjs";

// Built at runtime so this file never contains a secret-shaped literal.
const SHAPED = "pcu" + "_" + "Z".repeat(43);
const diff = (added) =>
  `diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -0,0 +1 @@\n+${added}\n`;

test("refuses an added line shaped like an upload secret", () => {
  assert.equal(findSecrets(diff(`token = "${SHAPED}"`), "").length, 1);
});

test("refuses the known secret value wherever it appears", () => {
  assert.ok(findSecrets(diff("prefix-known-value-suffix"), "known-value").length >= 1);
});

test("ignores removed lines", () => {
  assert.deepEqual(findSecrets(`+++ b/x.txt\n-${SHAPED}\n`, ""), []);
});

test("allows code that only builds the shape", () => {
  assert.deepEqual(findSecrets(diff('SECRET = "pcu" + "_" + "A" * 43'), ""), []);
});
```

- [ ] **Step 2: Run** `node --test scripts/tests/*.test.mjs`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `scripts/check-staged-secrets.mjs`:

```js
#!/usr/bin/env node
/**
 * Refuse a commit whose staged changes contain the upload secret, or anything
 * shaped like one. GitHub push protection cannot recognise a random secret, so
 * this hook is the control (spec §6.1 T13).
 *
 * Enable once per clone:  git config core.hooksPath scripts/hooks
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SECRET_SHAPE = /pcu_[A-Za-z0-9_-]{43}/;

export function findSecrets(diff, knownSecret) {
  const problems = [];
  let file = "";
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      file = line.slice(4).replace(/^b\//, "");
      continue;
    }
    if (!line.startsWith("+")) continue;
    if (SECRET_SHAPE.test(line)) problems.push(`${file}: a line shaped like an upload secret`);
    if (knownSecret && line.includes(knownSecret)) problems.push(`${file}: the upload secret itself`);
  }
  return problems;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const diff = execFileSync(
    "git",
    ["diff", "--cached", "--no-color", "--no-ext-diff", "--text", "-U0"],
    { cwd: root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  const secretPath = join(root, "docker", "secrets", "parkcast_upload_secret");
  const known = existsSync(secretPath) ? readFileSync(secretPath, "utf8").trim() : "";
  const problems = [...new Set(findSecrets(diff, known))];
  if (problems.length > 0) {
    console.error(`commit refused:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (invoked === fileURLToPath(import.meta.url).toLowerCase()) main();
```

`scripts/hooks/pre-commit` (LF line endings):

```sh
#!/bin/sh
# Refuses commits containing the upload secret. Enable once per clone:
#   git config core.hooksPath scripts/hooks
exec node "$(git rev-parse --show-toplevel)/scripts/check-staged-secrets.mjs"
```

`scripts/new-upload-secret.py`:

```python
"""Create the collector's upload secret file. Never prints the value.

    python scripts/new-upload-secret.py            # docker/secrets/parkcast_upload_secret
    python scripts/new-upload-secret.py --force    # rotate an existing one

The file holds exactly the secret -- no newline, no BOM -- so the same bytes can
be fed to `wrangler secret put` with a shell redirect (docs/deploy.md).
"""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from parkcast.upload import SECRET_RE, new_secret  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path,
                        default=ROOT / "docker" / "secrets" / "parkcast_upload_secret")
    parser.add_argument("--force", action="store_true", help="replace an existing secret")
    args = parser.parse_args()
    if args.out.exists() and not args.force:
        print(f"{args.out} already exists; pass --force to rotate it", file=sys.stderr)
        return 1
    value = new_secret()
    if not SECRET_RE.fullmatch(value):
        print("generated value has the wrong shape; nothing written", file=sys.stderr)
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(value.encode("ascii"))
    print(f"wrote a new upload secret to {args.out} ({len(value)} characters, not shown)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

In `.gitignore`, replace the line `.env` with:

```
# Secrets and local tool state (docs/deploy.md). Never commit these.
.env*
!.env.example
.dev.vars*
.wrangler/
docker/secrets/
*.pem
worker/node_modules/
web/.dev-artifacts/
```

Append to `.dockerignore`, one per line: `docker/secrets`, `web`, `worker`, `scripts`.

- [ ] **Step 4: Run** `node --test scripts/tests/*.test.mjs`. Expected: 4 pass.

- [ ] **Step 5: Prove the hook end to end, outside the repository.** In the scratchpad: `git init` a new
  repository, copy `scripts/check-staged-secrets.mjs` into its `scripts/`, create `leak.txt` with
  `node -e "process.stdout.write('pcu'+'_'+'Q'.repeat(43))" > leak.txt`, `git add leak.txt`, run
  `node scripts/check-staged-secrets.mjs`. Expected: exit 1 and "commit refused". Unstage it, stage a
  harmless file, expect exit 0. Also run `python scripts/new-upload-secret.py --out <scratch>/s` and
  confirm the file is 47 bytes with no trailing newline. Delete the scratch repository and file.

- [ ] **Step 6: Checkpoint** — `git add .gitignore .dockerignore scripts/new-upload-secret.py scripts/check-staged-secrets.mjs scripts/hooks/pre-commit scripts/tests/check-staged-secrets.test.mjs`, then `git update-index --chmod=+x scripts/hooks/pre-commit`. Do **not** run `git config core.hooksPath` — the user enables it in Task 13.

---

### Task 6: Harden the collector container, and rehearse it offline (§5.4)

**Files:**
- Modify: `docker/Dockerfile`, `docker/docker-compose.yml`
- Create: `docker/docker-compose.dryrun.yml`, `scripts/hardening-dryrun.py`

**Interfaces:**
- Consumes: `collector.fetch_json` (Task 2), `metadata.parse_metadata`, `scheduler.publish_artifacts`, `scheduler.archive_day(conn, day)`, `store.connect`, `store.prune`
- Produces: the hardened image definition. The live container is **not** recreated here (Task 13). The upload `secrets:` and `PARKCAST_UPLOAD_URL` are **not** added here either — compose refuses to start when a secret file is missing, so they arrive in Task 13 together with the file.

- [ ] **Step 1: `docker/Dockerfile`** becomes:

```dockerfile
FROM python:3.13-slim

# A fixed, unprivileged identity. Nothing in the image runs as root at runtime.
RUN groupadd --gid 10001 parkcast \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin parkcast

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
# No VOLUME declaration: compose already bind-mounts ../data, and under a plain
# `docker run` a VOLUME silently creates an anonymous volume that `docker rm`
# then orphans -- the operator loses the corpus without ever being told.
USER 10001:10001
CMD ["python", "-m", "parkcast"]
```

- [ ] **Step 2: `docker/docker-compose.yml`** becomes:

```yaml
services:
  collector:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    restart: unless-stopped
    # Hardening (docs/superpowers/specs/2026-09-14-deployment-design.md §5.4).
    # Read-only root; the only writable places are data/, /scratch and a small /tmp.
    read_only: true
    tmpfs:
      - /tmp:size=64m
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    # CPU is throttled, never killed. There is deliberately NO memory limit: an
    # OOM kill of the one irreplaceable process costs ticks that cannot be
    # re-fetched, and Docker Desktop's VM already bounds memory.
    cpus: "1.0"
    pids_limit: 256
    volumes:
      - ../data:/app/data
      # Snapshots for analysis go here, never to /tmp (docker/README.md).
      - ../../parkcast-scratch:/scratch
    environment:
      TZ: Asia/Taipei
```

- [ ] **Step 3: `docker/docker-compose.dryrun.yml`:**

```yaml
# A rehearsal of the hardened settings against a SNAPSHOT COPY of data/.
# It never polls the availability feed, never uploads, and never touches the live
# corpus: its only bind mount is the copy outside the repository.
name: parkcast-dryrun
services:
  rehearsal:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    read_only: true
    tmpfs:
      - /tmp:size=64m
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    cpus: "1.0"
    pids_limit: 256
    volumes:
      - ../../parkcast-dryrun/data:/app/data
      - ../scripts/hardening-dryrun.py:/app/hardening-dryrun.py:ro
    environment:
      TZ: Asia/Taipei
    entrypoint: ["python", "/app/hardening-dryrun.py"]
```

- [ ] **Step 4: `scripts/hardening-dryrun.py`:**

```python
"""Rehearse the collector's offline work under the hardened container settings.

Run only through docker/docker-compose.dryrun.yml, against a snapshot copy. It
makes ONE metadata request (what the collector does at startup and each
day-rollover) and never polls availability or uploads. It proves that uid 10001
can write through the Docker Desktop bind mount, that pyproj works on a
read-only root, and that a publish, a compaction and a prune complete.

    ... run --rm rehearsal --day 2026-09-13
"""
import argparse
import os
import sys
import time
from datetime import date
from pathlib import Path

from parkcast import config, store
from parkcast.collector import fetch_json
from parkcast.metadata import parse_metadata
from parkcast.scheduler import archive_day, publish_artifacts


def _peak(name: str) -> str:
    path = Path("/sys/fs/cgroup") / name
    return path.read_text().strip() if path.exists() else "n/a"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--day", required=True, type=date.fromisoformat,
                        help="a completed day in the snapshot whose cold file was removed")
    args = parser.parse_args()

    print(f"uid={os.getuid()} gid={os.getgid()}")
    if os.getuid() != 10001:
        print("FAIL: not running as uid 10001")
        return 1

    probe = config.DATA_DIR / ".write-probe"
    probe.write_bytes(b"ok")
    probe.unlink()
    print("bind mount writable by uid 10001")

    started = time.monotonic()
    lots = parse_metadata(fetch_json(config.METADATA_URL))
    print(f"metadata parsed on a read-only root: {len(lots)} lots in {time.monotonic() - started:.1f}s")

    conn = store.connect(config.DB_PATH)
    try:
        started = time.monotonic()
        publish_artifacts(conn, lots)
        print(f"publish ok in {time.monotonic() - started:.1f}s")

        cold = config.PARQUET_DIR / f"{args.day.isoformat()}.parquet"
        if cold.exists():
            print(f"FAIL: {cold} exists; remove it from the COPY first")
            return 1
        started = time.monotonic()
        archive_day(conn, args.day)
        print(f"compaction ok in {time.monotonic() - started:.1f}s: {cold.exists()=}")

        removed = store.prune(conn, int(time.time()) - config.HOT_RETENTION_SEC)
        print(f"prune ok: {removed} rows")
    finally:
        conn.close()

    print(f"memory.peak={_peak('memory.peak')} pids.peak={_peak('pids.peak')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 5: Validate both compose files without starting anything:**
`docker compose -f docker/docker-compose.yml config --quiet` and
`docker compose -f docker/docker-compose.dryrun.yml config --quiet`. Expected: no output, exit 0.
Confirm `docker inspect -f '{{.State.StartedAt}}' docker-collector-1` is unchanged afterwards.

- [ ] **Step 6: Take the snapshot copy** with the existing procedure in `docker/README.md`
("Analysing the corpus while it runs", step 1), but copy it to `D:/Projects/parkcast-dryrun/data`
(outside the repository) instead of `../parkcast-snap`, then remove `/tmp/snap` from the container.
Pick `DAY` = the day before the newest reading's Taipei date, and delete **the copy's**
`D:/Projects/parkcast-dryrun/data/cold/DAY.parquet`. Double-check the path starts with
`D:/Projects/parkcast-dryrun/` before deleting.

- [ ] **Step 7: Rehearse** (Git Bash):

```bash
MSYS_NO_PATHCONV=1 docker compose -f docker/docker-compose.dryrun.yml run --rm --build rehearsal --day DAY; echo "exit=$?"
```

Expected: `uid=10001`, `bind mount writable`, `metadata parsed`, `publish ok`, `compaction ok ... True`,
`prune ok`, a `memory.peak` and `pids.peak`, `exit=0`. Exit 137 means an OOM kill and is a failure.
- If only the bind-mount write fails: **Ruling** — keep every other setting, drop `USER` to root in the
  Dockerfile with a comment citing this measurement, and record it in the Review section. Do not relax
  anything else.
- Set `pids_limit` in both compose files to `max(256, 4 × pids.peak)` if that is larger.

- [ ] **Step 8: Clean up** `D:/Projects/parkcast-dryrun` (it is our own copy; confirm the path) and
remove the rehearsal image: `docker compose -f docker/docker-compose.dryrun.yml down --rmi local`.

- [ ] **Step 9: Checkpoint** — `git add docker/Dockerfile docker/docker-compose.yml docker/docker-compose.dryrun.yml scripts/hardening-dryrun.py`

---

### Task 7: The Worker — scaffold, routing and serving (§4.1, §4.2, §4.4)

**Files:**
- Create: `worker/package.json`, `worker/package-lock.json` (generated), `worker/tsconfig.json`, `worker/vitest.config.ts`, `worker/wrangler.jsonc`
- Create: `worker/src/http.ts`, `worker/src/kv.ts`, `worker/src/cache.ts`, `worker/src/serve.ts`, `worker/src/index.ts`
- Test: `worker/tests/setup.ts`, `worker/tests/fakes.ts`, `worker/tests/serve.test.ts`, `worker/tests/routes.test.ts`

**Interfaces:**
- Produces (used by Tasks 8, 11):
  - `kv.ts`: `LATEST_KEY`, `interface StoredMeta`, `interface ArtifactsKV`, `interface Env { ARTIFACTS; UPLOAD_SECRET; PRODUCTION_HOST }`, `asStoredMeta(v: unknown): StoredMeta | null`
  - `http.ts`: `respond(status, body, headers?)`, `notFound()`, `TEXT`
  - `cache.ts`: `class LatestCache(now?: () => number)` with `get(kv): Promise<Latest | null>`, `set(latest: Latest)`; `interface Latest { bytes: Uint8Array; meta: StoredMeta }`; `CACHE_TTL_MS = 60_000`
  - `index.ts`: `route(request, env, cache, nowSec): Promise<Response>` and the default `{ fetch }`
  - tests: `FakeKV` (counts `reads`/`writes`), `makePair({ baseDataTs, generatedAt?, nLots?, rosterId? })`, `metaFor(pair, overrides?)`

- [ ] **Step 1: Scaffold.** `worker/package.json`:

```json
{
  "name": "parkcast-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "dev": "wrangler dev --local"
  },
  "devDependencies": {
    "typescript": "6.0.3",
    "vitest": "5.0.0",
    "wrangler": "4.131.1"
  }
}
```

`worker/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "types": [],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "tests", "vitest.config.ts"]
}
```

`worker/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
  },
});
```

`worker/wrangler.jsonc` — **strict JSON, no comments** (the release script parses it with `JSON.parse`):

```json
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "parkcast",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "workers_dev": true,
  "preview_urls": false,
  "observability": { "enabled": false },
  "assets": {
    "directory": "../web/dist",
    "run_worker_first": ["/artifacts/*"],
    "not_found_handling": "404-page"
  },
  "kv_namespaces": [
    { "binding": "ARTIFACTS", "id": "REPLACE_WITH_PROD_KV_ID", "preview_id": "REPLACE_WITH_PREVIEW_KV_ID" }
  ],
  "vars": { "PRODUCTION_HOST": "parkcast.REPLACE-SUBDOMAIN.workers.dev" },
  "secrets": { "required": ["UPLOAD_SECRET"] }
}
```

Install from inside `worker/`: `cd worker && npm install --ignore-scripts` (npm 10 ignores `--prefix` when resolving package.json for install/ci/audit). Confirm
`worker/package-lock.json` exists and `worker/node_modules` is ignored (`git check-ignore worker/node_modules`).

- [ ] **Step 2: Test support.** `worker/tests/setup.ts`:

```ts
// Workers add crypto.subtle.timingSafeEqual; Node does not. A test-only stand-in
// with the same contract (throws on unequal lengths).
type Bytes = ArrayBuffer | ArrayBufferView;
const toBytes = (v: Bytes): Uint8Array =>
  v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

const subtle = globalThis.crypto.subtle as SubtleCrypto & { timingSafeEqual?: unknown };
if (typeof subtle.timingSafeEqual !== "function") {
  Object.defineProperty(subtle, "timingSafeEqual", {
    configurable: true,
    value: (a: Bytes, b: Bytes): boolean => {
      const x = toBytes(a);
      const y = toBytes(b);
      if (x.byteLength !== y.byteLength) throw new TypeError("Input buffers must have the same byte length");
      let diff = 0;
      for (let i = 0; i < x.byteLength; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
      return diff === 0;
    },
  });
}
```

`worker/tests/fakes.ts`:

```ts
import type { ArtifactsKV, StoredMeta } from "../src/kv";

export class FakeKV implements ArtifactsKV {
  reads = 0;
  writes = 0;
  failReads = false;
  private readonly entries = new Map<string, { value: ArrayBuffer; metadata: unknown }>();

  async getWithMetadata(key: string): Promise<{ value: ArrayBuffer | null; metadata: unknown }> {
    this.reads++;
    if (this.failReads) throw new Error("kv unavailable");
    const entry = this.entries.get(key);
    return { value: entry ? entry.value.slice(0) : null, metadata: entry ? entry.metadata : null };
  }

  async put(key: string, value: ArrayBuffer | Uint8Array, options: { metadata: StoredMeta }): Promise<void> {
    this.writes++;
    const copy = value instanceof Uint8Array ? (value.slice().buffer as ArrayBuffer) : value.slice(0);
    this.entries.set(key, { value: copy, metadata: options.metadata });
  }

  seed(key: string, bytes: Uint8Array, metadata: unknown): void {
    this.entries.set(key, { value: bytes.slice().buffer as ArrayBuffer, metadata });
  }
}

export interface Pair { grid: Uint8Array; lots: Uint8Array; baseDataTs: number; generatedAt: number; nLots: number; rosterId: number }

export function makePair(o: { baseDataTs: number; generatedAt?: number; nLots?: number; rosterId?: number }): Pair {
  const nLots = o.nLots ?? 3;
  const generatedAt = o.generatedAt ?? o.baseDataTs + 200;
  const rosterId = o.rosterId ?? 42;
  const grid = new Uint8Array(21 + nLots * 24);
  const dv = new DataView(grid.buffer);
  grid.set([0x50, 0x43, 0x47, 0x31], 0);
  dv.setUint8(4, 1);
  dv.setUint32(5, generatedAt, true);
  dv.setUint32(9, o.baseDataTs, true);
  dv.setUint16(13, nLots, true);
  dv.setUint8(15, 24);
  dv.setUint8(16, 5);
  dv.setUint32(17, rosterId, true);
  const rows = Array.from({ length: nLots }, (_unused, i) => ({
    i, id: `TPE${i}`, n: `lot ${i}`, a: "信義區", y: 25.03, x: 121.56, c: 50, t: "民營停車場",
    p: { k: "exact", lo: 40, hi: 40 },
  }));
  const lots = new TextEncoder().encode(JSON.stringify({
    v: 1, generated_at: generatedAt, base_data_ts: o.baseDataTs, n_lots: nLots, roster_id: rosterId, lots: rows,
  }));
  return { grid, lots, baseDataTs: o.baseDataTs, generatedAt, nLots, rosterId };
}

export function joined(pair: Pair): Uint8Array {
  const out = new Uint8Array(pair.grid.byteLength + pair.lots.byteLength);
  out.set(pair.grid, 0);
  out.set(pair.lots, pair.grid.byteLength);
  return out;
}

export function metaFor(pair: Pair, overrides: Partial<StoredMeta> = {}): StoredMeta {
  return {
    v: 1, gridLength: pair.grid.byteLength, nLots: pair.nLots, rosterId: pair.rosterId,
    generatedAt: pair.generatedAt, baseDataTs: pair.baseDataTs, uploadedAt: pair.baseDataTs + 250,
    gridSha256: "g".repeat(64), lotsSha256: "l".repeat(64), ...overrides,
  };
}
```

- [ ] **Step 3: Write the failing tests.** `worker/tests/serve.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LatestCache } from "../src/cache";
import { LATEST_KEY, type Env } from "../src/kv";
import { route } from "../src/index";
import { FakeKV, joined, makePair, metaFor } from "./fakes";

const NOW = 1_789_352_400;
const origin = "https://parkcast.example.workers.dev";

function setup(seed = true) {
  const kv = new FakeKV();
  const pair = makePair({ baseDataTs: NOW - 240, generatedAt: NOW - 30 });
  if (seed) kv.seed(LATEST_KEY, joined(pair), metaFor(pair));
  let clock = NOW * 1000;
  const cache = new LatestCache(() => clock);
  const env = { ARTIFACTS: kv, UPLOAD_SECRET: "x", PRODUCTION_HOST: "parkcast.example.workers.dev" } as Env;
  const get = (path: string, init?: RequestInit) => route(new Request(origin + path, init), env, cache, NOW);
  return { kv, pair, get, advance: (ms: number) => { clock += ms; } };
}

function expectSecurityHeaders(res: Response) {
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
}

describe("serving the forecast", () => {
  it("serves each half of the stored pair with its own caching", async () => {
    const { get, pair } = setup();
    const grid = await get("/artifacts/grid.bin");
    expect(grid.status).toBe(200);
    expect(new Uint8Array(await grid.arrayBuffer())).toEqual(pair.grid);
    expect(grid.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(grid.headers.get("Cache-Control")).toBe("max-age=300"); // clamp(gen+330-now) = 300
    expect(grid.headers.get("ETag")).toBe(`"${"g".repeat(64)}"`);
    expectSecurityHeaders(grid);

    const lots = await get("/artifacts/lots.json");
    expect(new Uint8Array(await lots.arrayBuffer())).toEqual(pair.lots);
    expect(lots.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(lots.headers.get("Cache-Control")).toBe("max-age=900");
    expect(lots.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });

  it("answers a weak or strong If-None-Match with 304 and no body", async () => {
    const { get } = setup();
    const res = await get("/artifacts/grid.bin", { headers: { "If-None-Match": `W/"${"g".repeat(64)}"` } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  it("sends no body for HEAD", async () => {
    const { get } = setup();
    const res = await get("/artifacts/lots.json", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("reads KV at most once a minute, even under concurrency", async () => {
    const { get, kv, advance } = setup();
    await Promise.all(Array.from({ length: 50 }, () => get("/artifacts/grid.bin")));
    expect(kv.reads).toBe(1);
    advance(59_000);
    await get("/artifacts/lots.json");
    expect(kv.reads).toBe(1);
    advance(2_000);
    await get("/artifacts/lots.json");
    expect(kv.reads).toBe(2);
  });

  it("says 503 when nothing is stored, and caches that answer too", async () => {
    const { get, kv } = setup(false);
    expect((await get("/artifacts/grid.bin")).status).toBe(503);
    expect((await get("/artifacts/grid.bin")).status).toBe(503);
    expect(kv.reads).toBe(1);
  });
});
```

`worker/tests/routes.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { route } from "../src/index";
import { LatestCache } from "../src/cache";
import type { Env } from "../src/kv";
import { FakeKV } from "./fakes";

const origin = "https://parkcast.example.workers.dev";
const NOW = 1_789_352_400;
const untouchableEnv = new Proxy({}, { get() { throw new Error("env was read"); } }) as unknown as Env;

afterEach(() => vi.unstubAllGlobals());

describe("routing", () => {
  it.each(["/", "/index.html", "/wp-login.php", "/.env", "/artifacts", "/artifacts%2Fgrid.bin", "/artifacts/%2e%2e/sw.js"])(
    "answers %s with 404 without reading env",
    async (path) => {
      const res = await route(new Request(origin + path), untouchableEnv, new LatestCache(), NOW);
      expect(res.status).toBe(404);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    },
  );

  it.each(["/artifacts/grid.bin/", "/artifacts/GRID.BIN", "/artifacts/grid.bin.tmp", "/artifacts/other"])(
    "answers unknown artifact path %s with 404",
    async (path) => {
      const env = { ARTIFACTS: new FakeKV(), UPLOAD_SECRET: "x", PRODUCTION_HOST: "h" } as Env;
      expect((await route(new Request(origin + path), env, new LatestCache(), NOW)).status).toBe(404);
    },
  );

  it("refuses other methods on known paths", async () => {
    const env = { ARTIFACTS: new FakeKV(), UPLOAD_SECRET: "x", PRODUCTION_HOST: "h" } as Env;
    const post = await route(new Request(origin + "/artifacts/grid.bin", { method: "POST" }), env, new LatestCache(), NOW);
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET, HEAD");
    const getLatest = await route(new Request(origin + "/artifacts/latest"), env, new LatestCache(), NOW);
    expect(getLatest.status).toBe(405);
    expect(getLatest.headers.get("Allow")).toBe("PUT");
  });

  it("turns an unexpected failure into a generic 500", async () => {
    const kv = new FakeKV();
    kv.failReads = true;
    const env = { ARTIFACTS: kv, UPLOAD_SECRET: "x", PRODUCTION_HOST: "h" } as Env;
    const res = await worker.fetch(new Request(origin + "/artifacts/grid.bin"), env);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal error");
  });

  it("never makes a subrequest", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("subrequest"); });
    const env = { ARTIFACTS: new FakeKV(), UPLOAD_SECRET: "x", PRODUCTION_HOST: "h" } as Env;
    expect((await route(new Request(origin + "/artifacts/grid.bin"), env, new LatestCache(), NOW)).status).toBe(503);
  });
});
```

- [ ] **Step 4: Run** `npm test --prefix worker`. Expected: FAIL (modules missing).

- [ ] **Step 5: Implement.** `worker/src/http.ts`:

```ts
/** Headers on every response the Worker generates; `_headers` does not reach these. */
const SECURITY: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

export const TEXT: Readonly<Record<string, string>> = { "Content-Type": "text/plain; charset=utf-8" };

export function respond(status: number, body: BodyInit | null, headers: Record<string, string> = {}): Response {
  // SECURITY is spread last so no caller can weaken it.
  return new Response(body, { status, headers: { "Cache-Control": "no-store", ...headers, ...SECURITY } });
}

export const notFound = (): Response => respond(404, "Not found", TEXT);
```

`worker/src/kv.ts`:

```ts
export const LATEST_KEY = "latest";

export interface StoredMeta {
  v: 1;
  gridLength: number;
  nLots: number;
  rosterId: number;
  generatedAt: number;
  baseDataTs: number;
  uploadedAt: number;
  gridSha256: string;
  lotsSha256: string;
}

/** The two KV calls the Worker makes; the real binding satisfies this. */
export interface ArtifactsKV {
  getWithMetadata(key: string, options: { type: "arrayBuffer" }): Promise<{ value: ArrayBuffer | null; metadata: unknown }>;
  put(key: string, value: ArrayBuffer | Uint8Array, options: { metadata: StoredMeta }): Promise<void>;
}

export interface Env {
  ARTIFACTS: ArtifactsKV;
  UPLOAD_SECRET: string;
  PRODUCTION_HOST: string;
}

const INTEGER_FIELDS = ["gridLength", "nLots", "rosterId", "generatedAt", "baseDataTs", "uploadedAt"] as const;

export function asStoredMeta(v: unknown): StoredMeta | null {
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  if (m.v !== 1 || !INTEGER_FIELDS.every((k) => Number.isInteger(m[k]))) return null;
  if (typeof m.gridSha256 !== "string" || typeof m.lotsSha256 !== "string") return null;
  return m as unknown as StoredMeta;
}
```

`worker/src/cache.ts`:

```ts
import { LATEST_KEY, asStoredMeta, type ArtifactsKV, type StoredMeta } from "./kv";

export const CACHE_TTL_MS = 60_000;

export interface Latest {
  /** `ArrayBuffer`-backed, so a slice is a valid `Response` body under TS 6's DOM types. */
  bytes: Uint8Array<ArrayBuffer>;
  meta: StoredMeta;
}

/** The latest pair, re-read from KV at most once a minute per isolate. */
export class LatestCache {
  private latest: Latest | null = null;
  private readAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<Latest | null> | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  get(kv: ArtifactsKV): Promise<Latest | null> {
    if (this.now() - this.readAt < CACHE_TTL_MS) return Promise.resolve(this.latest);
    if (this.inflight !== null) return this.inflight;
    this.inflight = kv.getWithMetadata(LATEST_KEY, { type: "arrayBuffer" }).then(
      ({ value, metadata }) => {
        const meta = asStoredMeta(metadata);
        const bytes = value === null ? null : new Uint8Array(value);
        this.latest = bytes !== null && meta !== null && meta.gridLength <= bytes.byteLength ? { bytes, meta } : null;
        this.readAt = this.now();
        this.inflight = null;
        return this.latest;
      },
      (error: unknown) => {
        this.inflight = null;
        throw error;
      },
    );
    return this.inflight;
  }

  set(latest: Latest): void {
    this.latest = latest;
    this.readAt = this.now();
    this.inflight = null;
  }
}
```

`worker/src/serve.ts`:

```ts
import type { LatestCache } from "./cache";
import { TEXT, respond } from "./http";
import type { Env } from "./kv";

export type Part = "grid" | "lots";

export const ARTIFACT_PATHS: Readonly<Record<string, Part>> = {
  "/artifacts/grid.bin": "grid",
  "/artifacts/lots.json": "lots",
};

export function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const bare = etag.replace(/^W\//, "");
  return header.split(",").some((token) => {
    const t = token.trim();
    return t === "*" || t.replace(/^W\//, "") === bare;
  });
}

export async function serveArtifact(request: Request, part: Part, env: Env, cache: LatestCache, nowSec: number): Promise<Response> {
  const latest = await cache.get(env.ARTIFACTS);
  if (latest === null) return respond(503, "No forecast yet", { ...TEXT, "Retry-After": "300" });
  const { bytes, meta } = latest;
  const body = part === "grid" ? bytes.subarray(0, meta.gridLength) : bytes.subarray(meta.gridLength);
  // lots.json changes rarely and the app bypasses the cache when the roster moves;
  // grid.bin is cached only until the next publish is due.
  const maxAge = part === "lots" ? 900 : Math.min(300, Math.max(0, meta.generatedAt + 330 - nowSec));
  const headers = {
    "Content-Type": part === "grid" ? "application/octet-stream" : "application/json; charset=utf-8",
    "Cache-Control": `max-age=${maxAge}`,
    ETag: `"${part === "grid" ? meta.gridSha256 : meta.lotsSha256}"`,
  };
  if (etagMatches(request.headers.get("If-None-Match"), headers.ETag)) return respond(304, null, headers);
  return respond(200, request.method === "HEAD" ? null : body, headers);
}
```

`worker/src/index.ts`:

```ts
import { LatestCache } from "./cache";
import { TEXT, notFound, respond } from "./http";
import type { Env } from "./kv";
import { ARTIFACT_PATHS, serveArtifact } from "./serve";

const isolateCache = new LatestCache();

export async function route(request: Request, env: Env, cache: LatestCache, nowSec: number): Promise<Response> {
  const url = new URL(request.url);
  // Before `env` is touched: scanners probing random paths cost nothing further.
  if (!url.pathname.startsWith("/artifacts/")) return notFound();

  if (url.pathname === "/artifacts/latest") {
    if (request.method !== "PUT") return respond(405, "Method not allowed", { ...TEXT, Allow: "PUT" });
    return notFound(); // Task 8 replaces this line with the host check and the upload.
  }

  const part = ARTIFACT_PATHS[url.pathname];
  if (part === undefined) return notFound();
  if (request.method !== "GET" && request.method !== "HEAD") {
    return respond(405, "Method not allowed", { ...TEXT, Allow: "GET, HEAD" });
  }
  return serveArtifact(request, part, env, cache, nowSec);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env, isolateCache, Math.floor(Date.now() / 1000));
    } catch {
      return respond(500, "Internal error", TEXT);
    }
  },
};
```

- [ ] **Step 6: Run** `npm test --prefix worker` and `npm run typecheck --prefix worker`. Expected: PASS, no type errors. (`/artifacts%2Fgrid.bin` must stay a 404: `%2F` is not decoded into a path separator by the URL parser.)

- [ ] **Step 7: Checkpoint** — `git add worker/package.json worker/package-lock.json worker/tsconfig.json worker/vitest.config.ts worker/wrangler.jsonc worker/src worker/tests`

---

### Task 8: The Worker — authenticated, validated upload (§4.3)

**Files:**
- Create: `worker/src/validate.ts`, `worker/src/upload.ts`
- Modify: `worker/src/index.ts` (the `/artifacts/latest` branch)
- Test: `worker/tests/validate.test.ts`, `worker/tests/upload.test.ts`

**Interfaces:**
- Consumes: `StoredMeta`, `asStoredMeta`, `LATEST_KEY`, `Env` (kv.ts); `respond`, `TEXT`, `notFound` (http.ts); `LatestCache.set` (cache.ts); `FakeKV`, `makePair`, `joined`, `metaFor` (tests/fakes.ts)
- Produces: `validatePair(grid, lots): { ok: true; header: GridHeader } | { ok: false }`, `checkOrder(header, stored, nowSec): Reject | null`, `parseGridHeader`; `handleUpload(request, env, cache, nowSec): Promise<Response>`, `authorized(header, secret)`, `readCapped(body, cap)`, `sha256Hex(bytes)`, `MAX_BODY_BYTES`

- [ ] **Step 1: Write the failing tests.** `worker/tests/validate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkOrder, parseGridHeader, validatePair } from "../src/validate";
import { makePair, metaFor } from "./fakes";

const NOW = 1_789_352_400;
const enc = new TextEncoder();

function mutateLots(lots: Uint8Array, change: (doc: any) => void): Uint8Array {
  const doc = JSON.parse(new TextDecoder().decode(lots));
  change(doc);
  return enc.encode(JSON.stringify(doc));
}

describe("validatePair", () => {
  const pair = makePair({ baseDataTs: NOW - 240 });

  it("accepts a well-formed pair", () => {
    expect(validatePair(pair.grid, pair.lots).ok).toBe(true);
  });

  it.each<[string, () => [Uint8Array, Uint8Array]]>([
    ["bad magic", () => { const g = pair.grid.slice(); g[0] = 0x51; return [g, pair.lots]; }],
    ["truncated grid", () => [pair.grid.slice(0, -1), pair.lots]],
    ["wrong horizon count", () => { const g = pair.grid.slice(); g[15] = 12; return [g, pair.lots]; }],
    ["invalid UTF-8", () => [pair.grid, new Uint8Array([0xff, 0xfe])]],
    ["JSON array", () => [pair.grid, enc.encode("[]")]],
    ["roster mismatch", () => [pair.grid, mutateLots(pair.lots, (d) => { d.roster_id = 1; })]],
    ["stamp mismatch", () => [pair.grid, mutateLots(pair.lots, (d) => { d.generated_at += 1; })]],
    ["row index shifted", () => [pair.grid, mutateLots(pair.lots, (d) => { d.lots[1].i = 2; })]],
    ["row outside Taipei", () => [pair.grid, mutateLots(pair.lots, (d) => { d.lots[0].y = 0; })]],
    ["201-character name", () => [pair.grid, mutateLots(pair.lots, (d) => { d.lots[0].n = "x".repeat(201); })]],
    ["unknown fare kind", () => [pair.grid, mutateLots(pair.lots, (d) => { d.lots[0].p = { k: "free" }; })]],
    ["fractional u", () => [pair.grid, mutateLots(pair.lots, (d) => { d.lots[0].u = 1.5; })]],
    ["negative capacity", () => [pair.grid, mutateLots(pair.lots, (d) => { d.lots[0].c = -1; })]],
  ])("rejects %s", (_label, build) => {
    const [grid, lots] = build();
    expect(validatePair(grid, lots).ok).toBe(false);
  });
});

describe("checkOrder", () => {
  const pair = makePair({ baseDataTs: NOW - 240, generatedAt: NOW - 30 });
  const header = parseGridHeader(pair.grid)!;
  const older = makePair({ baseDataTs: NOW - 540, generatedAt: NOW - 330 });
  const stored = (o = {}) => metaFor(older, { uploadedAt: NOW - 300, ...o });

  it.each<[string, () => string | null, string | null]>([
    ["first upload", () => checkOrder(header, null, NOW), null],
    ["newer than stored", () => checkOrder(header, stored(), NOW), null],
    ["replay of what is stored", () => checkOrder(header, metaFor(pair), NOW), "stale"],
    ["too soon after the last write", () => checkOrder(header, stored({ uploadedAt: NOW - 60 }), NOW), "too-soon"],
    ["future-dated reading", () => checkOrder({ ...header, baseDataTs: 4_294_967_295 }, null, NOW), "future"],
    ["stored future value is void", () => checkOrder(header, stored({ baseDataTs: 4_294_967_295 }), NOW), null],
    ["reading older than six hours", () => checkOrder(header, null, NOW + 7 * 3600), "too-old"],
    ["roster collapse", () => checkOrder({ ...header, nLots: 1 }, stored({ nLots: 1000 }), NOW), "roster-shrink"],
    ["roster collapse after a day of silence", () => checkOrder({ ...header, nLots: 1 }, stored({ nLots: 1000, uploadedAt: NOW - 25 * 3600 }), NOW), null],
    ["same reading, newer generation (PC clock behind)", () => checkOrder({ ...header, generatedAt: pair.generatedAt + 5 }, metaFor(pair, { uploadedAt: NOW - 300 }), NOW), null],
  ])("%s", (_label, run, want) => {
    expect(run()).toBe(want);
  });
});
```

`worker/tests/upload.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LatestCache } from "../src/cache";
import { route } from "../src/index";
import { LATEST_KEY, type Env } from "../src/kv";
import { handleUpload, sha256Hex } from "../src/upload";
import { FakeKV, joined, makePair, metaFor, type Pair } from "./fakes";

const NOW = 1_789_352_400;
const HOST = "parkcast.example.workers.dev";
const SECRET = "pcu" + "_" + "S".repeat(43); // built, never a literal

function setup() {
  const kv = new FakeKV();
  const cache = new LatestCache(() => NOW * 1000);
  const env: Env = { ARTIFACTS: kv, UPLOAD_SECRET: SECRET, PRODUCTION_HOST: HOST };
  const put = (pair: Pair, o: { auth?: string | null; host?: string; gridLength?: string; at?: number } = {}) => {
    const headers = new Headers({ "X-Grid-Length": o.gridLength ?? String(pair.grid.byteLength) });
    const auth = o.auth === undefined ? `Bearer ${SECRET}` : o.auth;
    if (auth !== null) headers.set("Authorization", auth);
    const request = new Request(`https://${o.host ?? HOST}/artifacts/latest`, { method: "PUT", headers, body: joined(pair) });
    return route(request, env, cache, o.at ?? NOW);
  };
  return { kv, cache, env, put };
}

/** A request object whose headers are not filtered, to test Content-Length handling. */
function rawRequest(headers: Record<string, string>, body: ReadableStream<Uint8Array>): Request {
  return { headers: new Headers(headers), body } as unknown as Request;
}

function streamOf(totalBytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      const chunk = new Uint8Array(Math.min(64_000, totalBytes - sent));
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
}

describe("upload", () => {
  it("stores a valid pair with Worker-computed hashes and serves it without another read", async () => {
    const { kv, env, cache, put } = setup();
    const pair = makePair({ baseDataTs: NOW - 240, generatedAt: NOW - 30 });
    expect((await put(pair)).status).toBe(204);
    expect(kv.writes).toBe(1);

    // The isolate that accepted the upload serves it straight from memory.
    const readsBefore = kv.reads;
    const res = await route(new Request(`https://${HOST}/artifacts/grid.bin`), env, cache, NOW);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pair.grid);
    expect(kv.reads).toBe(readsBefore);

    const { metadata } = await kv.getWithMetadata(LATEST_KEY);
    expect(metadata).toMatchObject({
      gridSha256: await sha256Hex(pair.grid.slice()),
      lotsSha256: await sha256Hex(pair.lots.slice()),
      uploadedAt: NOW,
    });
  });

  it.each([null, "", "Basic abc", `Bearer ${SECRET}x`, `Bearer ${"a".repeat(300)}`])(
    "refuses authorization %s before touching storage",
    async (auth) => {
      const { kv, put } = setup();
      const res = await put(makePair({ baseDataTs: NOW - 240 }), { auth });
      expect(res.status).toBe(401);
      expect([kv.reads, kv.writes]).toEqual([0, 0]);
    },
  );

  it("does not let a preview hostname write", async () => {
    const { kv, put } = setup();
    const res = await put(makePair({ baseDataTs: NOW - 240 }), { host: `abc123-${HOST}` });
    expect(res.status).toBe(404);
    expect([kv.reads, kv.writes]).toEqual([0, 0]);
  });

  it("refuses a declared oversize body, and an oversize stream whatever it declares", async () => {
    const { env, cache, kv } = setup();
    const auth = { Authorization: `Bearer ${SECRET}`, "X-Grid-Length": "45" };
    const declared = await handleUpload(rawRequest({ ...auth, "Content-Length": String(2 * 1024 * 1024) }, streamOf(10)), env, cache, NOW);
    expect(declared.status).toBe(413);
    const lying = await handleUpload(rawRequest({ ...auth, "Content-Length": "10" }, streamOf(2 * 1024 * 1024)), env, cache, NOW);
    expect(lying.status).toBe(413);
    const undeclared = await handleUpload(rawRequest(auth, streamOf(2 * 1024 * 1024)), env, cache, NOW);
    expect(undeclared.status).toBe(413);
    expect(kv.writes).toBe(0);
  });

  it.each(["0x15", "21abc", "1e3", "", "1", "99999999"])("refuses X-Grid-Length %s", async (gridLength) => {
    const { kv, put } = setup();
    expect((await put(makePair({ baseDataTs: NOW - 240 }), { gridLength })).status).toBe(422);
    expect(kv.writes).toBe(0);
  });

  it("refuses a replay, a too-soon write and a future-dated reading", async () => {
    const { kv, put } = setup();
    const pair = makePair({ baseDataTs: NOW - 240, generatedAt: NOW - 30 });
    expect((await put(pair)).status).toBe(204);
    const replay = await put(pair, { at: NOW + 400 });
    expect([replay.status, replay.headers.get("X-Reject")]).toEqual([409, "stale"]);
    const soon = await put(makePair({ baseDataTs: NOW + 60, generatedAt: NOW + 70 }), { at: NOW + 100 });
    expect([soon.status, soon.headers.get("X-Reject")]).toEqual([409, "too-soon"]);
    const future = await put(makePair({ baseDataTs: NOW + 3600, generatedAt: NOW + 3600 }), { at: NOW + 400 });
    expect([future.status, future.headers.get("X-Reject")]).toEqual([409, "future"]);
    expect(kv.writes).toBe(1);
  });

  it("is not locked out by a stored future-dated value", async () => {
    const { kv, put } = setup();
    const forged = makePair({ baseDataTs: 4_000_000_000, generatedAt: 4_000_000_000 });
    kv.seed(LATEST_KEY, joined(forged), metaFor(forged, { uploadedAt: NOW - 300 }));
    expect((await put(makePair({ baseDataTs: NOW - 240 }))).status).toBe(204);
  });

  it("does not let an unauthenticated flood read or write anything", async () => {
    const { kv, put } = setup();
    const pair = makePair({ baseDataTs: NOW - 240 });
    await Promise.all(Array.from({ length: 200 }, () => put(pair, { auth: "Bearer wrong" })));
    expect([kv.reads, kv.writes]).toEqual([0, 0]);
  });
});
```

- [ ] **Step 2: Run** `npm test --prefix worker`. Expected: the new files FAIL (modules missing); Task 7's tests still pass.

- [ ] **Step 3: Implement `worker/src/validate.ts`** — the prototype verified against the live 10:16 pair (see "Facts measured while planning"), with `StoredMeta` imported rather than redeclared:

```ts
import type { StoredMeta } from "./kv";

export const HEADER_SIZE = 21;
export const MAX_LOTS = 4000;
export const N_HORIZONS = 24;
export const STEP_MIN = 5;
export const GRID_VERSION = 1;
export const LOTS_VERSION = 1;
export const MAX_STRING = 200;
/** Same box as `LAT_MIN..LON_MAX` in src/parkcast/config.py. */
export const BBOX = { latMin: 24.5, latMax: 25.5, lonMin: 121.0, lonMax: 122.5 } as const;
export const FUTURE_TOLERANCE_SEC = 600;
export const MAX_BASE_AGE_SEC = 6 * 3600;
export const MIN_UPLOAD_SPACING_SEC = 180;
export const ROSTER_FLOOR = 0.5;
export const ROSTER_ESCAPE_SEC = 24 * 3600;
const PRICE_KINDS: ReadonlySet<string> = new Set(["exact", "range", "entry", "unknown"]);

export interface GridHeader {
  version: number;
  generatedAt: number;
  baseDataTs: number;
  nLots: number;
  nHorizons: number;
  stepMin: number;
  rosterId: number;
}

export type Reject = "future" | "too-old" | "stale" | "too-soon" | "roster-shrink";
export type PairResult = { ok: true; header: GridHeader } | { ok: false };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const shortString = (v: unknown): boolean => typeof v === "string" && v.length <= MAX_STRING;

const within = (v: unknown, lo: number, hi: number): boolean =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

const numberOrNull = (v: unknown): boolean =>
  v === null || (typeof v === "number" && Number.isFinite(v));

export function parseGridHeader(grid: Uint8Array): GridHeader | null {
  if (grid.byteLength < HEADER_SIZE) return null;
  if (grid[0] !== 0x50 || grid[1] !== 0x43 || grid[2] !== 0x47 || grid[3] !== 0x31) return null;
  const dv = new DataView(grid.buffer, grid.byteOffset, grid.byteLength);
  return {
    version: dv.getUint8(4),
    generatedAt: dv.getUint32(5, true),
    baseDataTs: dv.getUint32(9, true),
    nLots: dv.getUint16(13, true),
    nHorizons: dv.getUint8(15),
    stepMin: dv.getUint8(16),
    rosterId: dv.getUint32(17, true),
  };
}

function validRow(row: unknown, index: number): boolean {
  if (!isRecord(row) || row.i !== index) return false;
  if (!shortString(row.id) || !shortString(row.n) || !shortString(row.a) || !shortString(row.t)) {
    return false;
  }
  if (!within(row.y, BBOX.latMin, BBOX.latMax) || !within(row.x, BBOX.lonMin, BBOX.lonMax)) {
    return false;
  }
  if (!(row.c === null || (Number.isInteger(row.c) && (row.c as number) >= 0))) return false;
  const price = row.p;
  if (!isRecord(price) || typeof price.k !== "string" || !PRICE_KINDS.has(price.k)) return false;
  if (price.k !== "unknown" && !(numberOrNull(price.lo) && numberOrNull(price.hi))) return false;
  if ("u" in row && !Number.isInteger(row.u)) return false;
  return true;
}

export function validatePair(grid: Uint8Array, lotsBytes: Uint8Array): PairResult {
  const h = parseGridHeader(grid);
  if (h === null || h.version !== GRID_VERSION || h.nHorizons !== N_HORIZONS || h.stepMin !== STEP_MIN) {
    return { ok: false };
  }
  if (h.nLots < 1 || h.nLots > MAX_LOTS || grid.byteLength !== HEADER_SIZE + h.nLots * h.nHorizons) {
    return { ok: false };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(lotsBytes));
  } catch {
    return { ok: false };
  }
  if (
    !isRecord(doc) ||
    doc.v !== LOTS_VERSION ||
    doc.n_lots !== h.nLots ||
    doc.roster_id !== h.rosterId ||
    doc.generated_at !== h.generatedAt ||
    doc.base_data_ts !== h.baseDataTs
  ) {
    return { ok: false };
  }
  const rows = doc.lots;
  if (!Array.isArray(rows) || rows.length !== h.nLots) return { ok: false };
  for (let i = 0; i < rows.length; i++) {
    if (!validRow(rows[i], i)) return { ok: false };
  }
  return { ok: true, header: h };
}

export function checkOrder(h: GridHeader, stored: StoredMeta | null, now: number): Reject | null {
  if (h.baseDataTs > now + FUTURE_TOLERANCE_SEC || h.generatedAt > now + FUTURE_TOLERANCE_SEC) {
    return "future";
  }
  if (h.baseDataTs < now - MAX_BASE_AGE_SEC || h.generatedAt < h.baseDataTs - FUTURE_TOLERANCE_SEC) {
    return "too-old";
  }
  // A stored value dated in the future is void: it must never lock out real uploads.
  if (stored === null || stored.baseDataTs > now + FUTURE_TOLERANCE_SEC) return null;
  const newer =
    h.baseDataTs > stored.baseDataTs ||
    (h.baseDataTs === stored.baseDataTs && h.generatedAt > stored.generatedAt);
  if (!newer) return "stale";
  if (now - stored.uploadedAt < MIN_UPLOAD_SPACING_SEC) return "too-soon";
  if (h.nLots < ROSTER_FLOOR * stored.nLots && now - stored.uploadedAt <= ROSTER_ESCAPE_SEC) {
    return "roster-shrink";
  }
  return null;
}
```

- [ ] **Step 4: Implement `worker/src/upload.ts`:**

```ts
import type { LatestCache } from "./cache";
import { TEXT, respond } from "./http";
import { LATEST_KEY, asStoredMeta, type Env, type StoredMeta } from "./kv";
import { checkOrder, validatePair } from "./validate";

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_AUTH_HEADER_LENGTH = 200;
const GRID_LENGTH = /^[0-9]{2,7}$/;
const DECIMAL = /^[0-9]+$/;

type TimingSafeSubtle = SubtleCrypto & {
  timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
};

/** The secret's digest, computed once per isolate. */
let secretDigest: { secret: string; digest: Promise<ArrayBuffer> } | null = null;

const encode = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);

export async function authorized(header: string | null, secret: string): Promise<boolean> {
  if (header === null || header.length > MAX_AUTH_HEADER_LENGTH || !header.startsWith("Bearer ") || secret === "") {
    return false;
  }
  if (secretDigest === null || secretDigest.secret !== secret) {
    secretDigest = { secret, digest: crypto.subtle.digest("SHA-256", encode(secret)) };
  }
  // Comparing equal-length digests keeps timingSafeEqual from throwing and hides the secret's length.
  const [presented, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode(header.slice("Bearer ".length))),
    secretDigest.digest,
  ]);
  return (crypto.subtle as TimingSafeSubtle).timingSafeEqual(presented, expected);
}

/** The whole body, or null as soon as it passes `cap` bytes -- whatever Content-Length claimed. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleUpload(request: Request, env: Env, cache: LatestCache, nowSec: number): Promise<Response> {
  // 1. Authentication before anything else: no body read, no storage touched.
  if (!(await authorized(request.headers.get("Authorization"), env.UPLOAD_SECRET))) {
    return respond(401, "Unauthorized", TEXT);
  }
  // 2. Size, by declaration and then by counting.
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!DECIMAL.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    return respond(413, "Too large", TEXT);
  }
  const gridHeader = request.headers.get("X-Grid-Length") ?? "";
  if (!GRID_LENGTH.test(gridHeader)) return respond(422, "Invalid upload", TEXT);
  const body = await readCapped(request.body, MAX_BODY_BYTES);
  if (body === null) return respond(413, "Too large", TEXT);
  const gridLength = Number(gridHeader);
  if (gridLength > body.byteLength) return respond(422, "Invalid upload", TEXT);

  // 3. Shape.
  const grid = body.subarray(0, gridLength);
  const lots = body.subarray(gridLength);
  const result = validatePair(grid, lots);
  if (!result.ok) return respond(422, "Invalid upload", TEXT);

  // 4. Time and order, against what is stored (one KV read).
  const stored = await env.ARTIFACTS.getWithMetadata(LATEST_KEY, { type: "arrayBuffer" });
  const reject = checkOrder(result.header, asStoredMeta(stored.metadata), nowSec);
  if (reject !== null) return respond(409, "Not accepted", { ...TEXT, "X-Reject": reject });

  // 5. One write, with metadata the Worker computed itself.
  const meta: StoredMeta = {
    v: 1,
    gridLength,
    nLots: result.header.nLots,
    rosterId: result.header.rosterId,
    generatedAt: result.header.generatedAt,
    baseDataTs: result.header.baseDataTs,
    uploadedAt: nowSec,
    gridSha256: await sha256Hex(grid),
    lotsSha256: await sha256Hex(lots),
  };
  await env.ARTIFACTS.put(LATEST_KEY, body, { metadata: meta });
  cache.set({ bytes: body, meta });
  return respond(204, null);
}
```

If `tsc` rejects `request.body` against `ReadableStream<Uint8Array>`, widen the parameter to
`ReadableStream<Uint8Array<ArrayBufferLike>> | null` — do not add a cast at the call site.

- [ ] **Step 5: Wire the route.** In `worker/src/index.ts` add `import { handleUpload } from "./upload";`
and replace the line `return notFound(); // Task 8 replaces this line ...` with:

```ts
    // Preview URLs have their own hostnames; only the production hostname may write.
    if (url.hostname !== env.PRODUCTION_HOST) return notFound();
    return handleUpload(request, env, cache, nowSec);
```

- [ ] **Step 6: Run** `npm test --prefix worker` and `npm run typecheck --prefix worker`. Expected: all pass.

- [ ] **Step 7: Measure the upload's cost locally** on the real pair (git-ignored copy in
  `web/public/artifacts/` or, after Task 9, `web/.dev-artifacts/`): a throwaway vitest file in the
  scratchpad (not committed) that runs `validatePair` + both `sha256Hex` 200 times and prints the mean.
  Record the number in the Review section. §10.9's real measurement happens on Cloudflare in Task 13.

- [ ] **Step 8: Checkpoint** — `git add worker/src worker/tests`

---

### Task 9: Web — root base, localhost-only dev server, budgeted live data (§7, §6.1 T14)

**Files:**
- Create: `web/dev/liveArtifacts.ts` (no Node types), `web/dev/localArtifacts.ts` (Node only)
- Modify: `web/vite.config.ts`, `web/tsconfig.node.json`, `scripts/sync-artifacts.mjs`, `scripts/refresh-demo-artifacts.py`
- Test: `web/tests/liveArtifacts.test.ts`

**Interfaces:**
- Produces: `parseLiveOrigin(raw: string): string`; `createLiveArtifacts({ origin, fetchImpl?, now?, refreshMs?, budgetPerHour? })` → `(req: DevRequest, res: DevResponse, next: Next) => Promise<void>`; `createLocalArtifacts(dir: string)` with the same middleware shape; `ARTIFACT_TYPES`
- Dev data now lives in git-ignored `web/.dev-artifacts/`, never under `web/public/` (so a build can never contain it).

- [ ] **Step 1: Write the failing test** `web/tests/liveArtifacts.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createLiveArtifacts, parseLiveOrigin } from "../dev/liveArtifacts";

const ORIGIN = "https://parkcast.example.workers.dev";

function fakeRes() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; },
    end(body?: Uint8Array | string) { this.body = body; },
  };
}

function setup(o: { refreshMs?: number; budgetPerHour?: number } = {}) {
  let clock = 1_000_000;
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(new Uint8Array([1, 2, 3])));
  const mw = createLiveArtifacts({ origin: ORIGIN, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock, ...o });
  const hit = async (url: string, method = "GET") => {
    const res = fakeRes();
    const next = vi.fn();
    await mw({ url, method }, res, next);
    return { res, next };
  };
  return { fetchImpl, hit, advance: (ms: number) => { clock += ms; } };
}

describe("live artifacts middleware", () => {
  it("turns ten thousand local requests into at most two upstream requests", async () => {
    const { fetchImpl, hit } = setup();
    for (let i = 0; i < 5_000; i++) {
      await hit("/artifacts/grid.bin");
      await hit("/artifacts/lots.json?t=1");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("serves the copy with its type and nothing cached by the browser", async () => {
    const { hit } = setup();
    const { res } = await hit("/artifacts/lots.json");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("forwards no browser headers and refuses upstream redirects", async () => {
    const { fetchImpl, hit } = setup();
    await hit("/artifacts/grid.bin");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/artifacts/grid.bin`);
    expect(init).toEqual({ redirect: "error", headers: {} });
  });

  it("refuses anything but GET and HEAD, and ignores other paths", async () => {
    const { fetchImpl, hit } = setup();
    expect((await hit("/artifacts/latest", "PUT")).next).toHaveBeenCalled();
    const put = await hit("/artifacts/grid.bin", "PUT");
    expect(put.res.statusCode).toBe(405);
    expect((await hit("/src/main.tsx")).next).toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops at the hourly budget and serves the last copy", async () => {
    const { fetchImpl, hit, advance } = setup({ refreshMs: 0, budgetPerHour: 5 });
    for (let i = 0; i < 100; i++) expect((await hit("/artifacts/grid.bin")).res.statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    advance(3_600_000);
    await hit("/artifacts/grid.bin");
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("answers 429 when the budget is spent before any copy exists", async () => {
    const { hit } = setup({ budgetPerHour: 0 });
    expect((await hit("/artifacts/grid.bin")).res.statusCode).toBe(429);
  });

  it.each(["http://parkcast.example.workers.dev", `${ORIGIN}/path`, `${ORIGIN}/?q=1`, "not a url"])(
    "rejects live origin %s",
    (raw) => expect(() => parseLiveOrigin(raw)).toThrow(),
  );
});
```

- [ ] **Step 2: Run** `npm test --prefix web -- liveArtifacts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `web/dev/liveArtifacts.ts`:**

```ts
/**
 * Dev only: serve the two forecast files from the LIVE site through one shared
 * copy, so local testing uses today's data but cannot use up the live site's
 * daily Worker limit, even if code under edit loops (spec §7, §6.1 T14).
 *
 * Deliberately free of Node types, so the app's tests can import it.
 */
export interface DevRequest { url?: string; method?: string }
export interface DevResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: Uint8Array | string): unknown;
}
export type Next = () => void;

export const ARTIFACT_TYPES: ReadonlyMap<string, string> = new Map([
  ["/artifacts/grid.bin", "application/octet-stream"],
  ["/artifacts/lots.json", "application/json; charset=utf-8"],
]);

export interface LiveOptions {
  origin: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  refreshMs?: number;
  budgetPerHour?: number;
}

export function parseLiveOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("PARKCAST_LIVE_ORIGIN must be an https origin with no path, e.g. https://parkcast.<name>.workers.dev");
  }
  return url.origin;
}

export function createLiveArtifacts(options: LiveOptions) {
  const origin = parseLiveOrigin(options.origin);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const refreshMs = options.refreshMs ?? 60_000;
  const budget = options.budgetPerHour ?? 120;
  const copies = new Map<string, { body: Uint8Array; at: number }>();
  const inflight = new Map<string, Promise<void>>();
  let windowStart = now();
  let used = 0;

  async function refresh(path: string): Promise<void> {
    if (now() - windowStart >= 3_600_000) {
      windowStart = now();
      used = 0;
    }
    if (used >= budget) return;
    used++;
    const upstream = await fetchImpl(origin + path, { redirect: "error", headers: {} });
    if (!upstream.ok) return;
    copies.set(path, { body: new Uint8Array(await upstream.arrayBuffer()), at: now() });
  }

  return async function liveArtifacts(req: DevRequest, res: DevResponse, next: Next): Promise<void> {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const type = ARTIFACT_TYPES.get(path);
    if (type === undefined) return next();
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      res.end();
      return;
    }
    const copy = copies.get(path);
    if (copy === undefined || now() - copy.at >= refreshMs) {
      let pending = inflight.get(path);
      if (pending === undefined) {
        pending = refresh(path)
          .catch(() => undefined)
          .finally(() => inflight.delete(path));
        inflight.set(path, pending);
      }
      await pending;
    }
    const served = copies.get(path);
    if (served === undefined) {
      res.statusCode = used >= budget ? 429 : 503;
      res.end("live forecast unavailable");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "no-store");
    res.end(req.method === "HEAD" ? undefined : served.body);
  };
}
```

`web/dev/localArtifacts.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACT_TYPES, type DevRequest, type DevResponse, type Next } from "./liveArtifacts.ts";

/** Dev only: serve `web/.dev-artifacts/` (filled by scripts/sync-artifacts.mjs). */
export function createLocalArtifacts(dir: string) {
  return async (req: DevRequest, res: DevResponse, next: Next): Promise<void> => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const type = ARTIFACT_TYPES.get(path);
    if (type === undefined) return next();
    try {
      const body = await readFile(join(dir, path.slice("/artifacts/".length)));
      res.statusCode = 200;
      res.setHeader("Content-Type", type);
      res.setHeader("Cache-Control", "no-store");
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.statusCode = 404;
      res.end("no local artifacts: run scripts/sync-artifacts.mjs, or set PARKCAST_LIVE_ORIGIN");
    }
  };
}
```

- [ ] **Step 4: Replace `web/vite.config.ts`:**

```ts
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { createLiveArtifacts } from './dev/liveArtifacts.ts'
import { createLocalArtifacts } from './dev/localArtifacts.ts'

/**
 * Forecast files for `npm run dev`. With PARKCAST_LIVE_ORIGIN set, from the live
 * site through a shared, budgeted copy; otherwise from web/.dev-artifacts/.
 * Nothing under public/ -- whatever is there is copied into every build.
 */
function devArtifacts(): Plugin {
  const live = process.env.PARKCAST_LIVE_ORIGIN
  const middleware = live
    ? createLiveArtifacts({ origin: live })
    : createLocalArtifacts(fileURLToPath(new URL('./.dev-artifacts', import.meta.url)))
  return {
    name: 'parkcast-dev-artifacts',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        middleware(req, res, next).catch(next)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // The app is served from the root of its workers.dev address (docs/deploy.md).
  // PARKCAST_BASE overrides it -- set it from PowerShell: Git Bash rewrites "/"
  // into a Windows path (measured 2026-09-14).
  base: process.env.PARKCAST_BASE ?? '/',
  plugins: [react(), devArtifacts()],
  // Never reachable from the network: the dev server can read files and relay the live site.
  server: { host: '127.0.0.1', strictPort: true },
  preview: { host: '127.0.0.1', strictPort: true },
  test: {
    // jsdom, not node: later tasks render components against this same config.
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Registers the jest-dom matchers. Without it `toBeInTheDocument()` fails
    // as "not a function" -- an error that points at the assertion rather than
    // at the missing wiring, and costs the next author an afternoon.
    setupFiles: ['./tests/setup.ts'],
  },
})
```

In `web/tsconfig.node.json` change `"include": ["vite.config.ts"]` to `"include": ["vite.config.ts", "dev"]`.
If `tsc` rejects passing Connect's `req`/`res` to the structural `DevRequest`/`DevResponse`, adapt
inside `configureServer` with a small wrapper object — keep `web/dev/liveArtifacts.ts` free of Node types.

- [ ] **Step 5: Move dev data out of `public/`.**
  - `scripts/sync-artifacts.mjs`: `join(repoRoot, "web", "public", "artifacts")` → `join(repoRoot, "web", ".dev-artifacts")`; update the header comment and the log line to `web/.dev-artifacts/`.
  - `scripts/refresh-demo-artifacts.py`: replace every `web/public/artifacts` (the docstring and the `--out` default) with `web/.dev-artifacts`.
  - Move the existing local copy: `mkdir -p web/.dev-artifacts && mv web/public/artifacts/* web/.dev-artifacts/ && rmdir web/public/artifacts`.

- [ ] **Step 6: Run** `npm test --prefix web`, `npm run typecheck --prefix web`, `npm run lint --prefix web`. Expected: all pass.

- [ ] **Step 7: Verify by hand.**
  - `npm run build --prefix web`, then list `web/dist`: **no `artifacts/` directory**; `index.html` asset URLs start with `/assets/`.
  - Start `npm run dev --prefix web`; `curl -s -o NUL -w "%{http_code} %{size_download}" http://127.0.0.1:5173/artifacts/grid.bin` → `200` and the file's size; `Get-NetTCPConnection -LocalPort 5173 -State Listen` shows only `127.0.0.1`. Stop the server.

- [ ] **Step 8: Checkpoint** — `git add web/dev web/vite.config.ts web/tsconfig.node.json web/tests/liveArtifacts.test.ts scripts/sync-artifacts.mjs scripts/refresh-demo-artifacts.py`

---

### Task 10: Web — security headers, fallback styles, 404 page, future-dated forecasts (§6.2)

**Files:**
- Create: `web/public/_headers`, `web/public/404.html`, `web/public/robots.txt`, `web/public/fallback.css`
- Modify: `web/index.html`, `web/public/sw.js` (`PRECACHE`), `web/src/App.tsx` (the artifact fetch effect)
- Test: `web/tests/siteHardening.test.ts`, `web/tests/app.test.tsx`

**Interfaces:**
- Produces: `FUTURE_TOLERANCE_SEC = 600` exported from `web/src/App.tsx`; the files `_headers`, `404.html`, `robots.txt` and `fallback.css`, which the deploy gate (Task 11) requires.

- [ ] **Step 1: Write the failing tests.** `web/tests/siteHardening.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(WEB, "public");
const read = (...parts: string[]) => readFileSync(join(...parts), "utf8");

describe("site hardening", () => {
  it("sends a strict Content-Security-Policy on every static file", () => {
    const headers = read(PUBLIC, "_headers");
    const csp = headers.match(/Content-Security-Policy: (.*)/)?.[1] ?? "";
    for (const directive of [
      "default-src 'self'", "script-src 'self'", "style-src 'self'", "worker-src 'self'",
      "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/worker-src[^;]*blob:/);
    expect(headers).toContain("X-Content-Type-Options: nosniff");
    expect(headers).toMatch(/^\/sw\.js\r?\n\s+Cache-Control: no-cache/m);
  });

  it("has no inline style or inline script in index.html", () => {
    const html = read(WEB, "index.html");
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).toContain('href="/fallback.css"');
  });

  it("precaches the fallback stylesheet", () => {
    expect(read(PUBLIC, "sw.js")).toContain('"./fallback.css"');
  });

  it("keeps crawlers out of the forecast files", () => {
    expect(read(PUBLIC, "robots.txt")).toMatch(/^Disallow: \/artifacts\/$/m);
  });

  it("ships a bilingual 404 page with no inline style", () => {
    const html = read(PUBLIC, "404.html");
    expect(html).toContain('lang="zh-Hant"');
    expect(html).not.toMatch(/\sstyle=/);
  });
});
```

In `web/tests/app.test.tsx`, next to the existing test for an initial load that fails (find the test
that renders the load-failure state; mirror its assertion for that state), add:

```tsx
  it("refuses a forecast dated in the future instead of calling it fresh", async () => {
    const grid = makeGrid();
    // base_data_ts sits at header offset 9; an hour ahead of the frozen clock.
    new DataView(grid).setUint32(9, BASE_DATA_TS + 3600, true);
    stubFetch(grid);
    render(<App />);
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.queryByTestId("staleness")).toBeNull();
  });
```

Next to "keeps showing the forecast it has when a refresh fails" (same describe, same setup), add the
spec §9 bound — our own code must not turn a dead network into a request loop:

```tsx
  it("keeps its request rate bounded when every fetch fails for an hour", async () => {
    useDrivableFakeTimers();
    render(<App />);
    await screen.findByTestId("staleness");
    let calls = 0;
    vi.stubGlobal("fetch", () => {
      calls++;
      return Promise.reject(new Error("offline"));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    });

    // One refresh per REFRESH_MS asks for both files; a failure must never trigger a retry loop.
    expect(calls).toBeLessThanOrEqual(2 * Math.ceil((60 * 60 * 1000) / REFRESH_MS) + 2);
  });
```

If the load-failure state in this file is asserted by something other than `role="alert"`, use that
instead — the requirement is "the could-not-load state, never a staleness line".

- [ ] **Step 2: Run** `npm test --prefix web -- siteHardening app`. Expected: FAIL.

- [ ] **Step 3: Create the public files.**

`web/public/_headers` (LF line endings; header lines indented two spaces):

```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; worker-src 'self'; connect-src 'self'; font-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: geolocation=(self), camera=(), microphone=(), payment=(), usb=()
  Cross-Origin-Opener-Policy: same-origin
  X-Frame-Options: DENY
/sw.js
  Cache-Control: no-cache
```

`web/public/fallback.css`:

```css
/* The static boot fallback in index.html and 404.html. Unhashed and precached,
   so it is still there in the offline case the fallback exists for, and the
   Content-Security-Policy needs no 'unsafe-inline'. No colours: the app's own
   light and dark themes still apply when it is only the script that failed. */
.boot-fallback {
  margin: 0 auto;
  max-width: 26rem;
  padding: 4rem 1.5rem;
  font-family: system-ui, sans-serif;
  line-height: 1.6;
}
```

`web/public/404.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Not found — ParkCast 停車先知</title>
    <link rel="stylesheet" href="/fallback.css" />
  </head>
  <body>
    <div class="boot-fallback">
      <p>This page does not exist. <a href="/">Open ParkCast</a>.</p>
      <p lang="zh-Hant">找不到此頁面。<a href="/">開啟停車先知</a>。</p>
    </div>
  </body>
</html>
```

`web/public/robots.txt`:

```
User-agent: *
Disallow: /artifacts/
```

- [ ] **Step 4: Update `web/index.html`.**
  - After the `<link rel="manifest" … />` line add `<link rel="stylesheet" href="/fallback.css" />`.
  - Replace `<div style="margin: 0 auto; max-width: 26rem; padding: 4rem 1.5rem; font-family: system-ui, sans-serif; line-height: 1.6">` with `<div class="boot-fallback">`.
  - In the comment above it, replace "Styles are inline because the stylesheet is one of the files that may be missing, and no colour is set so the app's own light and dark themes still apply when it is only the script that failed." with "It is styled by the unhashed, precached `/fallback.css` rather than the hashed bundle, which is one of the files that may be missing — and not inline, so the Content-Security-Policy needs no `'unsafe-inline'`."
  - In the comment on the icon links, replace "(`/ParkCast/`)" with "(`/` on workers.dev)".

- [ ] **Step 5: Update `web/public/sw.js`.** Add `"./fallback.css",` to `PRECACHE` after `"./manifest.webmanifest",`.
  Do not bump `VERSION` (nothing deployed has ever used it).

- [ ] **Step 6: Update `web/src/App.tsx`.** After `MIN_REFETCH_MS` add:

```ts
/**
 * How far ahead of this device's clock a reading may claim to be before it is
 * refused. A reading from the future is a broken clock upstream or a forged
 * upload; shown as it is, it would read "0 min old" forever (spec §6.2).
 */
export const FUTURE_TOLERANCE_SEC = 600;
```

In the artifact fetch effect, change the success handler to:

```ts
      (loaded) => {
        if (cancelled) return;
        if (loaded.grid.baseDataTs > Date.now() / 1000 + FUTURE_TOLERANCE_SEC) {
          // Handled exactly like a failed load: keep the grid we have, or say we
          // could not load. Never present it as fresh.
          if (!loadedRef.current) setLoadFailed(true);
          return;
        }
        loadedRef.current = true;
        setArtifacts(loaded);
        setLoadFailed(false);
      },
```

- [ ] **Step 7: Run** `npm test --prefix web`, `npm run typecheck --prefix web`, `npm run lint --prefix web`. Expected: all pass.

- [ ] **Step 8: Checkpoint** — `git add web/public/_headers web/public/404.html web/public/robots.txt web/public/fallback.css web/index.html web/public/sw.js web/src/App.tsx web/tests/siteHardening.test.ts web/tests/app.test.tsx`

---

### Task 11A: The deploy gate's checks — bundle allowlist and live smoke test (§8.3)

**Files:**
- Create: `scripts/check-deploy-bundle.mjs`, `scripts/smoke-live.mjs`
- Test: `scripts/tests/check-deploy-bundle.test.mjs`, `scripts/tests/smoke-live.test.mjs`

**Interfaces:**
- Produces (used by Task 11B): `checkBundle({ distDir, workerDir?, secrets?, basemapBytes? }) -> string[]` (problems; empty means pass) and `listFiles(root) -> string[]` (POSIX relative paths); `smoke(origin, { fetchImpl?, now? }) -> Promise<{ failures: string[]; warnings: string[] }>`. Both files are also CLIs that exit 1 on a problem.

- [ ] **Step 1: Write the failing tests.** `scripts/tests/check-deploy-bundle.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { checkBundle } from "../check-deploy-bundle.mjs";

let dist;
const put = (rel, content = "x") => {
  mkdirSync(dirname(join(dist, rel)), { recursive: true });
  writeFileSync(join(dist, rel), content);
};
const check = (extra = {}) => checkBundle({ distDir: dist, basemapBytes: [1, 1000], ...extra });

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), "dist-"));
  for (const f of ["index.html", "404.html", "sw.js", "manifest.webmanifest", "_headers", "fallback.css",
    "robots.txt", "favicon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png",
    "assets/index-DsYeQuWT.js", "assets/index-Bmp4thyU.css", "assets/maplibre-gl-worker-AbPoOmO0.js"]) put(f);
  put("basemap/taipei.pmtiles", "p".repeat(500));
});
afterEach(() => rmSync(dist, { recursive: true, force: true }));

test("passes a clean build", () => assert.deepEqual(check(), []));

for (const [label, rel] of [
  ["a source map", "assets/index-DsYeQuWT.js.map"],
  ["a TypeScript file", "src/main.tsx"],
  ["an env file", ".env.production"],
  ["wrangler local secrets", ".dev.vars"],
  ["forecast data", "artifacts/grid.bin"],
  ["a database", "hot.sqlite"],
  ["an unknown file", "notes.txt"],
]) {
  test(`fails on ${label}`, () => {
    put(rel);
    assert.ok(check().length > 0, rel);
  });
}

test("fails when the basemap is missing or the wrong size", () => {
  rmSync(join(dist, "basemap/taipei.pmtiles"));
  assert.ok(check().some((p) => p.includes("basemap/taipei.pmtiles")));
  put("basemap/taipei.pmtiles", "p".repeat(5000));
  assert.ok(check().some((p) => p.includes("basemap size")));
});

test("fails on the upload secret, its shape, or the deploy key anywhere in any file", () => {
  const shaped = "pcu" + "_" + "K".repeat(43);
  put("assets/index-DsYeQuWT.js", `const leaked = "${shaped}";`);
  assert.ok(check().some((p) => p.includes("secret")));
  put("assets/index-DsYeQuWT.js", "ordinary");
  put("sw.js", "token-value-1234567890abcdef");
  assert.ok(check({ secrets: ["token-value-1234567890abcdef"] }).some((p) => p.includes("secret")));
});

test("scans a Worker bundle directory too", () => {
  const worker = mkdtempSync(join(tmpdir(), "worker-"));
  try {
    writeFileSync(join(worker, "index.js"), "export default {}");
    writeFileSync(join(worker, "index.js.map"), "{}");
    assert.ok(check({ workerDir: worker }).some((p) => p.includes("index.js.map")));
  } finally {
    rmSync(worker, { recursive: true, force: true });
  }
});
```

`scripts/tests/smoke-live.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { smoke } from "../smoke-live.mjs";

const ORIGIN = "https://parkcast.example.workers.dev";
const NOW = 1_789_352_400_000;
const SITE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'";

function gridBytes(rosterId, baseDataTs) {
  const g = new Uint8Array(21 + 24);
  const dv = new DataView(g.buffer);
  g.set([0x50, 0x43, 0x47, 0x31]);
  dv.setUint32(9, baseDataTs, true);
  dv.setUint32(17, rosterId, true);
  return g;
}

function site(overrides = {}) {
  const routes = {
    "GET /": () => new Response("<html>", { headers: { "content-security-policy": SITE_CSP, "x-content-type-options": "nosniff" } }),
    "GET /sw.js": () => new Response("", { headers: { "cache-control": "no-cache" } }),
    "GET /artifacts/grid.bin": () => new Response(gridBytes(7, NOW / 1000 - 240)),
    "GET /artifacts/lots.json": () => new Response(JSON.stringify({ roster_id: 7 })),
    "PUT /artifacts/latest": () => new Response("", { status: 401 }),
    ...overrides,
  };
  return async (url, init = {}) => {
    const key = `${init.method ?? "GET"} ${new URL(url).pathname}`;
    return (routes[key] ?? (() => new Response("", { status: 404 })))();
  };
}

test("passes a healthy site", async () => {
  const { failures, warnings } = await smoke(ORIGIN, { fetchImpl: site(), now: () => NOW });
  assert.deepEqual([failures, warnings], [[], []]);
});

test("fails when a source path is served", async () => {
  const { failures } = await smoke(ORIGIN, { fetchImpl: site({ "GET /src/main.tsx": () => new Response("code") }), now: () => NOW });
  assert.ok(failures.some((f) => f.includes("/src/main.tsx")));
});

test("fails when an unauthenticated upload is not refused", async () => {
  const { failures } = await smoke(ORIGIN, { fetchImpl: site({ "PUT /artifacts/latest": () => new Response("", { status: 204 }) }), now: () => NOW });
  assert.ok(failures.some((f) => f.includes("PUT")));
});

test("fails when the forecast files do not pair", async () => {
  const { failures } = await smoke(ORIGIN, { fetchImpl: site({ "GET /artifacts/lots.json": () => new Response(JSON.stringify({ roster_id: 8 })) }), now: () => NOW });
  assert.ok(failures.some((f) => f.includes("pair")));
});

test("only warns when the forecast is old, because the collector may be paused", async () => {
  const { failures, warnings } = await smoke(ORIGIN, { fetchImpl: site(), now: () => NOW + 3 * 3600_000 });
  assert.deepEqual(failures, []);
  assert.equal(warnings.length, 1);
});

test("only warns when nothing is stored yet, so the first release is not rolled back", async () => {
  const empty = () => new Response("No forecast yet", { status: 503 });
  const { failures, warnings } = await smoke(ORIGIN, {
    fetchImpl: site({ "GET /artifacts/grid.bin": empty, "GET /artifacts/lots.json": empty }),
    now: () => NOW,
  });
  assert.deepEqual(failures, []);
  assert.ok(warnings.some((w) => w.includes("no forecast stored yet")));
});
```

- [ ] **Step 2: Run** `node --test scripts/tests/*.test.mjs`. Expected: the two new files FAIL (modules missing).

- [ ] **Step 3: Implement `scripts/check-deploy-bundle.mjs`:**

```js
#!/usr/bin/env node
/**
 * The deploy gate's content check (spec §8.3 step 3). Node built-ins only.
 *
 *   node scripts/check-deploy-bundle.mjs [--worker-bundle worker/.wrangler/dry]
 *
 * Every uploaded file must be on the allowlist, required files must exist, and no
 * byte of any file may contain the upload secret, its shape, the deploy key or a
 * private key.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MiB = 1024 * 1024;

export const ALLOWED = [
  /^index\.html$/, /^404\.html$/, /^sw\.js$/, /^manifest\.webmanifest$/, /^favicon\.svg$/,
  /^icon-(192|512|maskable-512)\.png$/, /^_headers$/, /^robots\.txt$/, /^fallback\.css$/,
  /^basemap\/taipei\.pmtiles$/, /^assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(js|css)$/,
];
export const REQUIRED = [
  "index.html", "404.html", "sw.js", "manifest.webmanifest", "_headers", "fallback.css",
  "robots.txt", "basemap/taipei.pmtiles",
];
export const FORBIDDEN = [
  /\.map$/i, /\.(ts|tsx|py)$/i, /(^|\/)\.env/i, /(^|\/)\.dev\.vars/i,
  /\.(sqlite|db|parquet)$/i, /^artifacts\//, /^data\//,
];
const SECRET_SHAPE = /pcu_[A-Za-z0-9_-]{43}/;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export function listFiles(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(root, "");
  return out.sort();
}

function scanContent(path, label, secrets, problems) {
  const text = readFileSync(path).toString("latin1");
  if (SECRET_SHAPE.test(text)) problems.push(`secret-shaped string in ${label}`);
  if (PRIVATE_KEY.test(text)) problems.push(`private key in ${label}`);
  for (const secret of secrets) {
    if (secret && text.includes(secret)) problems.push(`a known secret value in ${label}`);
  }
}

export function checkBundle({ distDir, workerDir = null, secrets = [], basemapBytes = [15 * MiB, 25 * MiB] }) {
  const problems = [];
  const files = listFiles(distDir);
  for (const rel of files) {
    if (FORBIDDEN.some((r) => r.test(rel))) problems.push(`forbidden file: ${rel}`);
    else if (!ALLOWED.some((r) => r.test(rel))) problems.push(`not on the allowlist: ${rel}`);
    if (statSync(join(distDir, rel)).size >= 25 * MiB) problems.push(`over the 25 MiB asset limit: ${rel}`);
    scanContent(join(distDir, rel), rel, secrets, problems);
  }
  for (const rel of REQUIRED) {
    if (!files.includes(rel)) problems.push(`missing required file: ${rel}`);
  }
  if (files.includes("basemap/taipei.pmtiles")) {
    const size = statSync(join(distDir, "basemap/taipei.pmtiles")).size;
    const [min, max] = basemapBytes;
    if (size < min || size >= max) problems.push(`basemap size ${size} outside ${min}..${max}`);
  }
  if (workerDir) {
    for (const rel of listFiles(workerDir)) {
      if (FORBIDDEN.some((r) => r.test(rel))) problems.push(`forbidden file in the Worker bundle: ${rel}`);
      scanContent(join(workerDir, rel), `worker/${rel}`, secrets, problems);
    }
  }
  return problems;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const flag = process.argv.indexOf("--worker-bundle");
  const workerDir = flag > 0 ? resolve(process.argv[flag + 1]) : null;
  const secretPath = join(root, "docker", "secrets", "parkcast_upload_secret");
  const secrets = [
    existsSync(secretPath) ? readFileSync(secretPath, "utf8").trim() : "",
    process.env.CLOUDFLARE_API_TOKEN ?? "",
  ].filter((s) => s.length >= 16);
  const problems = checkBundle({ distDir: join(root, "web", "dist"), workerDir, secrets });
  if (problems.length > 0) {
    console.error(`deploy bundle check FAILED:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`deploy bundle check passed (${listFiles(join(root, "web", "dist")).length} files)`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (invoked === fileURLToPath(import.meta.url).toLowerCase()) main();
```

- [ ] **Step 4: Implement `scripts/smoke-live.mjs`:**

```js
#!/usr/bin/env node
/**
 * Read-only checks against the live site after a deploy (spec §8.3 step 9).
 *
 *   node scripts/smoke-live.mjs https://parkcast.<name>.workers.dev
 *
 * Freshness is a warning, never a failure: the user pauses the collector at times.
 * The preview-host PUT refusal is covered by the Worker's unit tests, not here.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MUST_404 = ["/src/main.tsx", "/assets/index.js.map", "/.env", "/_headers", "/wp-login.php", "/artifacts/grid.bin.tmp"];

export async function smoke(origin, { fetchImpl = fetch, now = Date.now } = {}) {
  const failures = [];
  const warnings = [];
  const get = (path, init = {}) => fetchImpl(origin + path, { redirect: "manual", ...init });

  const root = await get("/");
  if (root.status !== 200) failures.push(`/ answered ${root.status}`);
  const csp = root.headers.get("content-security-policy") ?? "";
  if (!csp.includes("default-src 'self'") || csp.includes("unsafe-inline")) failures.push("/ lacks the site Content-Security-Policy");
  if (root.headers.get("x-content-type-options") !== "nosniff") failures.push("/ lacks X-Content-Type-Options: nosniff");

  const sw = await get("/sw.js");
  if (!(sw.headers.get("cache-control") ?? "").includes("no-cache")) failures.push("/sw.js is not served no-cache");

  const grid = await get("/artifacts/grid.bin");
  const lots = await get("/artifacts/lots.json");
  if (grid.status === 503 && lots.status === 503) {
    // Nothing uploaded yet: the first release goes out before the collector uploads.
    warnings.push("no forecast stored yet (first release, or the collector is not uploading)");
  } else if (grid.status !== 200 || lots.status !== 200) {
    failures.push(`forecast files answered ${grid.status} and ${lots.status}`);
  } else {
    const bytes = new Uint8Array(await grid.arrayBuffer());
    const doc = JSON.parse(await lots.text());
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = String.fromCharCode(...bytes.subarray(0, 4));
    if (bytes.byteLength < 21 || magic !== "PCG1" || dv.getUint32(17, true) !== doc.roster_id) {
      failures.push("grid.bin and lots.json do not pair");
    } else {
      const ageMin = (now() / 1000 - dv.getUint32(9, true)) / 60;
      if (ageMin > 15) warnings.push(`forecast is ${Math.round(ageMin)} min old (collector paused?)`);
    }
  }

  for (const path of MUST_404) {
    const res = await get(path);
    if (res.status !== 404) failures.push(`${path} answered ${res.status}, expected 404`);
  }

  const put = await get("/artifacts/latest", { method: "PUT", body: "x", headers: { "X-Grid-Length": "21" } });
  if (put.status !== 401) failures.push(`unauthenticated PUT answered ${put.status}, expected 401`);

  return { failures, warnings };
}

async function main() {
  const origin = new URL(process.argv[2] ?? "").origin;
  const { failures, warnings } = await smoke(origin);
  for (const w of warnings) console.warn(`warning: ${w}`);
  if (failures.length > 0) {
    console.error(`smoke test FAILED:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("smoke test passed");
}

const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (invoked === fileURLToPath(import.meta.url).toLowerCase()) await main();
```

- [ ] **Step 5: Run** `node --test scripts/tests/*.test.mjs`. Expected: all pass.

- [ ] **Step 6: Checkpoint** — `git add scripts/check-deploy-bundle.mjs scripts/smoke-live.mjs scripts/tests/check-deploy-bundle.test.mjs scripts/tests/smoke-live.test.mjs`

---

### Task 11B: The two-phase deploy — check without a key, release with only `wrangler` (§7, §8.3, §6.1 T8)

**Files:**
- Create: `scripts/deploy-check.mjs`, `scripts/release.mjs`
- Modify: `worker/package.json` (scripts)
- Test: `scripts/tests/release.test.mjs`

**Interfaces:**
- Consumes: `checkBundle`, `listFiles` (Task 11A); `smoke` (Task 11A)
- Produces: `findPlaceholders(text) -> string[]`, `parseVersionId(output) -> string | null`, `parsePreviewUrl(output) -> string | null` in `scripts/release.mjs`; npm scripts `deploy:check`, `deploy:release`, `deploy:preview` in `worker/package.json`

- [ ] **Step 1: Verify `wrangler`'s real interface before writing code against it** (from `worker/`):
  `npx --no-install wrangler --version` (expect `4.131.1`), and the `--help` of `deploy`,
  `versions upload`, `versions deploy` and `rollback`. Confirm: `deploy --dry-run --outdir`; the
  version-id line `versions upload` prints; `versions deploy <id>@100%` and its non-interactive flag;
  `rollback` with a non-interactive flag and `--message`. **If any differs from the code below, change
  the code and the tests to match what `--help` says**, and record the difference in the Review
  section. Do not run any command that needs a login.

- [ ] **Step 2: Verify installs without lifecycle scripts (§10.7).** Run
  `npm ci --ignore-scripts` inside `worker/` then `npx --no-install wrangler --version` there, and
  `npm ci --ignore-scripts` inside `web/` then `npm test --prefix web` and `npm run build --prefix web`.
  If a package fails without its install script, note which package and why in the Review section,
  and document the exception in Task 12's `docs/deploy.md`; do not silently drop `--ignore-scripts`.

- [ ] **Step 3: Write the failing test** `scripts/tests/release.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { findPlaceholders, parsePreviewUrl, parseVersionId } from "../release.mjs";

test("finds every setup sentinel left in the Worker config", () => {
  const text = '{"id":"REPLACE_WITH_PROD_KV_ID","vars":{"PRODUCTION_HOST":"parkcast.REPLACE-SUBDOMAIN.workers.dev"}}';
  assert.deepEqual(findPlaceholders(text), ["REPLACE_WITH_PROD_KV_ID", "REPLACE-SUBDOMAIN"]);
});

test("accepts a filled-in config", () => {
  assert.deepEqual(findPlaceholders('{"id":"0123456789abcdef0123456789abcdef"}'), []);
});

test("reads the version id and preview URL from wrangler output", () => {
  const out = "Uploaded parkcast\nWorker Version ID: 1b2c3d4e-0000-4000-8000-123456789abc\nVersion Preview URL: https://1b2c3d4e-parkcast.example.workers.dev\n";
  assert.equal(parseVersionId(out), "1b2c3d4e-0000-4000-8000-123456789abc");
  assert.equal(parsePreviewUrl(out), "https://1b2c3d4e-parkcast.example.workers.dev");
  assert.equal(parseVersionId("nothing here"), null);
});
```

- [ ] **Step 4: Run** `node --test scripts/tests/*.test.mjs`. Expected: `release.test.mjs` FAILS (module missing).

- [ ] **Step 5: Implement `scripts/deploy-check.mjs`:**

```js
#!/usr/bin/env node
/**
 * Deploy phase 1 (spec §7, §8.3): every check, with NO Cloudflare credential in
 * the environment -- tests, builds and linters run third-party code, and none of
 * it gets to see the deploy key.
 *
 *   npm run deploy:check --prefix worker            # add -- --with-python when src/ changed
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBundle, listFiles } from "./check-deploy-bundle.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON_TESTS =
  'docker run --rm -v "D:/Projects/ParkCast/src:/repo/src:ro" -v "D:/Projects/ParkCast/tests:/repo/tests:ro" ' +
  '-v "D:/Projects/ParkCast/pyproject.toml:/repo/pyproject.toml:ro" -w /repo -e PYTHONDONTWRITEBYTECODE=1 ' +
  'docker-collector:latest sh -c "pip install -q pytest 2>/dev/null; python -m pytest -q -p no:cacheprovider tests/"';

function run(label, command, cwd = ROOT) {
  console.log(`\n=== ${label}: ${command}`);
  // Fixed command strings only; shell is needed to run npm.cmd/npx.cmd on Windows.
  const result = spawnSync(command, { cwd, shell: true, stdio: "inherit", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  if (result.status !== 0) {
    console.error(`\ndeploy check FAILED at: ${label}`);
    process.exit(1);
  }
}

if (process.env.CLOUDFLARE_API_TOKEN) {
  console.error("CLOUDFLARE_API_TOKEN is set. Run the check phase in a shell without the deploy key.");
  process.exit(1);
}

if (process.argv.includes("--with-python")) run("python tests", PYTHON_TESTS);
run("web tests", "npm test --prefix web");
run("web typecheck", "npm run typecheck --prefix web");
run("web lint", "npm run lint --prefix web");
run("worker tests", "npm test --prefix worker");
run("worker typecheck", "npm run typecheck --prefix worker");
run("script tests", "node --test scripts/tests/*.test.mjs");
run("production build", "npm run build --prefix web");
run("worker bundle (dry run)", "npx --no-install wrangler deploy --dry-run --outdir .wrangler/dry", join(ROOT, "worker"));

const secretPath = join(ROOT, "docker", "secrets", "parkcast_upload_secret");
const secrets = existsSync(secretPath) ? [readFileSync(secretPath, "utf8").trim()] : [];
const problems = checkBundle({
  distDir: join(ROOT, "web", "dist"),
  workerDir: join(ROOT, "worker", ".wrangler", "dry"),
  secrets,
});
if (problems.length > 0) {
  console.error(`\ndeploy bundle check FAILED:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nbundle check passed: ${listFiles(join(ROOT, "web", "dist")).length} files`);

console.log("\n=== npm audit (review the output; not a pass/fail gate)");
spawnSync("npm audit", { cwd: join(ROOT, "web"), shell: true, stdio: "inherit" });
spawnSync("npm audit", { cwd: join(ROOT, "worker"), shell: true, stdio: "inherit" });
console.log("\nCheck phase complete. Release from a fresh PowerShell: see docs/deploy.md.");
```

- [ ] **Step 6: Implement `scripts/release.mjs`:**

```js
#!/usr/bin/env node
/**
 * Deploy phase 2 (spec §7, §8.3): upload a version, promote it, smoke-test the
 * live site, and roll back automatically if the smoke test fails.
 *
 * Run ONLY in a fresh PowerShell where the user entered the deploy key with
 * Read-Host -AsSecureString, after `npm run deploy:check` passed. It runs the
 * pinned wrangler in worker/node_modules and Node built-ins -- nothing else.
 *
 *   npm run deploy:release --prefix worker
 *   npm run deploy:preview --prefix worker     # upload a preview version; never promoted
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBundle } from "./check-deploy-bundle.mjs";
import { smoke } from "./smoke-live.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = join(ROOT, "worker");

export function findPlaceholders(text) {
  return [...new Set(text.match(/REPLACE[A-Z_-]*/g) ?? [])];
}

export function parseVersionId(output) {
  return output.match(/Worker Version ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] ?? null;
}

export function parsePreviewUrl(output) {
  return output.match(/https:\/\/[A-Za-z0-9.-]+\.workers\.dev/)?.[0] ?? null;
}

function fail(message) {
  console.error(`release STOPPED: ${message}`);
  process.exit(1);
}

function wrangler(args, config) {
  const command = `npx --no-install wrangler ${args} --config ${config}`;
  console.log(`\n=== ${command}`);
  const result = spawnSync(command, { cwd: WORKER, shell: true, encoding: "utf8" });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  return { ok: result.status === 0, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function main() {
  const preview = process.argv.includes("--preview");
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (token.length < 16) fail("the deploy key is not set in this shell (docs/deploy.md)");

  const configText = readFileSync(join(WORKER, "wrangler.jsonc"), "utf8");
  const placeholders = findPlaceholders(configText);
  if (placeholders.length > 0) fail(`worker/wrangler.jsonc still has setup sentinels: ${placeholders.join(", ")}`);
  const config = JSON.parse(configText);
  if (!existsSync(join(WORKER, ".wrangler", "dry"))) fail("run the check phase first (npm run deploy:check --prefix worker)");

  // Scan again, now that the deploy key exists to be leaked.
  const secretPath = join(ROOT, "docker", "secrets", "parkcast_upload_secret");
  const secrets = [token, existsSync(secretPath) ? readFileSync(secretPath, "utf8").trim() : ""].filter(Boolean);
  const problems = checkBundle({ distDir: join(ROOT, "web", "dist"), workerDir: join(WORKER, ".wrangler", "dry"), secrets });
  if (problems.length > 0) fail(`bundle check failed:\n  ${problems.join("\n  ")}`);

  let configPath = "wrangler.jsonc";
  if (preview) {
    mkdirSync(join(WORKER, ".wrangler"), { recursive: true });
    writeFileSync(join(WORKER, ".wrangler", "preview.jsonc"), JSON.stringify({ ...config, preview_urls: true }, null, 2));
    configPath = ".wrangler/preview.jsonc";
  }

  const upload = wrangler("versions upload", configPath);
  if (!upload.ok) fail("versions upload failed; nothing changed on the live site");
  const versionId = parseVersionId(upload.output);
  if (versionId === null) fail("could not read the version id from wrangler's output");

  if (preview) {
    console.log(`\npreview version ${versionId}: ${parsePreviewUrl(upload.output) ?? "see the wrangler output above"}`);
    console.log("It is not live. Deploy normally to switch preview URLs off again.");
    return;
  }

  const deploy = wrangler(`versions deploy ${versionId}@100% --yes`, configPath);
  if (!deploy.ok) fail("versions deploy failed; the previous version is still live");

  const origin = `https://${config.vars.PRODUCTION_HOST}`;
  let result = { failures: ["not run"], warnings: [] };
  for (let attempt = 1; attempt <= 3; attempt++) {
    await sleep(20_000); // let the new version reach the edge before judging it
    result = await smoke(origin);
    if (result.failures.length === 0) break;
    console.warn(`smoke attempt ${attempt} failed:\n  ${result.failures.join("\n  ")}`);
  }
  for (const w of result.warnings) console.warn(`warning: ${w}`);
  if (result.failures.length > 0) {
    const rollback = wrangler('rollback --yes --message "smoke test failed"', configPath);
    fail(rollback.ok ? "smoke test failed; rolled back to the previous version"
      : "smoke test failed AND the rollback failed: run `npx wrangler rollback` by hand now");
  }
  console.log(`\ndeployed version ${versionId} to ${origin}; smoke test passed`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (invoked === fileURLToPath(import.meta.url).toLowerCase()) await main();
```

- [ ] **Step 7: Add the npm scripts** to `worker/package.json` `"scripts"`:

```json
    "deploy:check": "node ../scripts/deploy-check.mjs",
    "deploy:release": "node ../scripts/release.mjs",
    "deploy:preview": "node ../scripts/release.mjs --preview"
```

- [ ] **Step 8: Run** `node --test scripts/tests/*.test.mjs`. Expected: all pass.
  Then run the check phase for real, **without** any key set: `npm run deploy:check --prefix worker`.
  Expected: every step passes **except** the bundle check reporting `missing required file: basemap/taipei.pmtiles`
  (the basemap is rebuilt in Task 13). Any other failure is a defect to fix now.
  Also confirm `npm run deploy:release --prefix worker` stops immediately with
  "the deploy key is not set in this shell" — it must never reach `wrangler`.

- [ ] **Step 9: Checkpoint** — `git add scripts/deploy-check.mjs scripts/release.mjs scripts/tests/release.test.mjs worker/package.json`

---

### Task 12: Documentation (§12)

**Files:**
- Create: `docs/deploy.md`
- Modify: `README.md`, `CLAUDE.md`, `docs/state-of-play.md`, `docker/README.md`, `docs/pwa.md`, `web/README.md`, `docs/basemap.md`

**Interfaces:** consumes the names, commands and file paths from Tasks 1–11 exactly; any command a
document shows must be one a task actually built or verified.

- [ ] **Step 1: `docs/deploy.md`** with these sections, in this order:
  1. **What is deployed where** — one paragraph and the §3 diagram: app and basemap as static assets,
     the forecast in one KV key, the collector's upload thread, `https://parkcast.<name>.workers.dev`.
  2. **Rules that keep it free** — the §3.1 rules verbatim, and the budget table.
  3. **One-time setup (you do every step that touches a credential)**, with these exact commands:
     - Create the Cloudflare account (no card), turn on two-factor sign-in, choose a **neutral**
       `workers.dev` subdomain (it is public and effectively permanent).
     - GitHub: two-factor sign-in, secret-scanning push protection, then
       `git config core.hooksPath scripts/hooks`.
     - A short-lived **setup key** (custom token, this account only, expiry one day) with the
       permissions Task 13 confirms, entered in a **fresh PowerShell**:
       ```powershell
       $s = Read-Host -AsSecureString -Prompt "Cloudflare API token"
       $env:CLOUDFLARE_API_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
       $env:CLOUDFLARE_ACCOUNT_ID = "<account id from the dashboard>"
       ```
     - `cd worker`, then `npx --no-install wrangler kv namespace create ARTIFACTS` and the same with
       the preview flag Task 11B Step 1 confirmed; the two ids go into `worker/wrangler.jsonc`.
     - `python scripts\new-upload-secret.py`, then
       `cmd /c "npx --no-install wrangler secret put UPLOAD_SECRET < ..\docker\secrets\parkcast_upload_secret"`
       — through `cmd` because a PowerShell pipe appends a newline and the two copies would differ.
     - `Remove-Item Env:CLOUDFLARE_API_TOKEN`, and revoke the setup key in the dashboard.
     - The **deploy key**: custom token, this account only, least permissions, expiry of days.
  4. **Everyday: test locally against live data** — in PowerShell:
     `$env:PARKCAST_LIVE_ORIGIN = "https://parkcast.<name>.workers.dev"; npm run dev --prefix web`.
     What the middleware guarantees (GET/HEAD only, one copy a minute, 120 upstream requests an hour,
     localhost only). Never `--host`. Without the variable it serves `web/.dev-artifacts/`.
  5. **Deploying** — `npm run deploy:check --prefix worker` in a normal shell (add `-- --with-python`
     when `src/` changed); then a fresh PowerShell, enter the deploy key as above,
     `npm run deploy:release --prefix worker`, then `Remove-Item Env:CLOUDFLARE_API_TOKEN`. What the release
     does (re-scan, upload, promote, `wrangler triggers deploy`, smoke test three times, automatic rollback,
     the preview-host check). `deploy:preview` for a phone test (it runs `triggers deploy` with
     `preview_urls: true` first), and that preview URLs stay on until the next normal release's
     `triggers deploy` switches them off.
  6. **The collector's upload** — the log lines and what each means: `uploaded N bytes in S s`,
     `upload not needed: stale|too-soon|...`, `upload skipped: paused|backing off|daily cap reached`,
     `upload unauthorized; retrying in an hour`, `upload refused by the daily limit; pausing`,
     `uploads disabled (...)`.
  7. **Runbook** — the §6.4 table, with the exact commands.
  8. **Security rules** — never add a payment method; never set the key in the check-phase shell;
     never `wrangler login`; never `--host`; never commit `docker/secrets/`, `.dev.vars`, `.wrangler/`;
     rotate on suspicion; the flooding limit the user accepted (§6.3).

- [ ] **Step 2: Update the other documents.**
  - `README.md`: a "Deployment" subsection pointing to `docs/deploy.md` — free on Workers + KV, tested
    locally against live data, two-phase deploy, hardened collector. Keep "never been deployed" wording
    until Task 13 replaces it with the live address.
  - `CLAUDE.md`: a new load-bearing section "Deployment (2026-09-14)": the free rules; Workers KV, not R2,
    and why; the two-phase deploy and why the check phase has no key; secrets never logged, committed or
    in the image; `web/.dev-artifacts/` and why nothing goes under `web/public/`; base `/`; Git Bash
    rewriting `/` into a Windows path; the upload guard's bounds; the hardened container and why it has
    no memory limit; the prune fix (a day compaction keeps failing is never pruned); collector pauses
    are the user's own choice, not incidents.
  - `docs/state-of-play.md`: in "What to do next", remove "Guard the collector against people" (the
    09-13 pause was the user's own, deliberate) and replace "Deploy the app" with the Cloudflare plan and
    its status; note the prune bug fixed; update the test counts from a real run.
  - `docker/README.md`: the hardened settings and why; `docker/docker-compose.dryrun.yml`; the snapshot
    procedure now writes to `/scratch/snap` (host `D:/Projects/parkcast-scratch/snap`) instead of
    `/tmp/snap`, so no `docker cp` is needed; the secret file and that compose will not start without it
    once Task 13 adds it; the new upload log lines; the pause section reframed — a pause is usually the
    user's own, and a gap is lost training data, not a fault.
  - `docs/pwa.md`: base `/` on workers.dev instead of `/ParkCast/`; `fallback.css` precached; `/sw.js`
    served `Cache-Control: no-cache`; `npm run preview` now serves at `/`.
  - `web/README.md`: `web/.dev-artifacts/` replaces `public/artifacts/`; `PARKCAST_LIVE_ORIGIN` (set from PowerShell).
  - `docs/basemap.md`: the deploy gate requires the file at 15–25 MiB, under Workers' 25 MiB per-file limit.

- [ ] **Step 3: Check every command and path in the changed documents** against the repository
  (`Grep` for each script name, npm script and file path). Fix any that do not exist.

- [ ] **Step 4: Checkpoint** — `git add docs/deploy.md README.md CLAUDE.md docs/state-of-play.md docker/README.md docs/pwa.md web/README.md docs/basemap.md`

---

### Task 13: Hand back, and go live with the user (controller only; every credential step is the user's)

Nothing in this task happens without the user's explicit yes, asked separately for: commits, push,
the `go-pmtiles` download, the first release, and recreating the collector.

- [ ] **Step 1: Write the Review section** (below): per-task outcome, test counts from real runs
  (Python, web, worker, scripts), every ruling, the Task 8 local CPU number, the `wrangler` flags as
  verified, the `--ignore-scripts` result, and the dry-run measurements.
- [ ] **Step 2: Ask to commit** — list one Conventional Commit per task (no `Co-Authored-By`, no AI
  attribution), and whether to push the branch. Nothing is committed without a yes.
- [ ] **Step 3: The user's one-time setup** from `docs/deploy.md` §3. The user tells the controller only
  non-secret values: the subdomain and the two KV namespace ids. The controller then fills
  `worker/wrangler.jsonc` (`id`, `preview_id`, `PRODUCTION_HOST`) and `config.UPLOAD_HOST`, and adds to
  the `collector` service in `docker/docker-compose.yml`:
  ```yaml
      environment:
        TZ: Asia/Taipei
        PARKCAST_UPLOAD_URL: https://parkcast.<name>.workers.dev/artifacts/latest
      secrets:
        - parkcast_upload_secret
  ```
  plus a top-level
  ```yaml
  secrets:
    parkcast_upload_secret:
      file: ./secrets/parkcast_upload_secret
  ```
  Run the Python suite and `npm test --prefix worker` again.
- [ ] **Step 4: The basemap.** Ask permission to download `go-pmtiles_1.31.2_Windows_x86_64.zip` from
  <https://github.com/protomaps/go-pmtiles/releases/tag/v1.31.2> (state its size from the release page),
  verify the SHA-256 in `docs/basemap.md`, run `node scripts/build-basemap.mjs`, and confirm the file is
  15–25 MiB.
- [ ] **Step 5: Check phase** — `npm run deploy:check --prefix worker -- --with-python`, no key in the
  shell. Everything must pass, including the bundle check.
- [ ] **Step 6: First release — the user runs it** in a fresh PowerShell (`docs/deploy.md` §5). The smoke
  test's forecast checks warn "no forecast stored yet" on this first release, because nothing has
  uploaded; every other check must pass.
- [ ] **Step 7: Roll out the collector** (with a yes), just after a tick (minute ≡ 1 mod 5, second ≈ 40):
  `docker compose -f docker/docker-compose.yml up -d --build --force-recreate`. Confirm the next two
  ticks log `tick`, `published … not updating` and `uploaded … bytes`; `docker inspect -f
  '{{.State.OOMKilled}} {{.RestartCount}} {{.Config.User}}'` shows `false 0 10001:10001`; the row count
  keeps growing. Confirm the `/scratch` bind mount is writable by uid 10001 (untested until now):
  `MSYS_NO_PATHCONV=1 docker exec docker-collector-1 python -c "import pathlib; p = pathlib.Path('/scratch/.probe'); p.write_bytes(b'ok'); p.unlink(); print('scratch writable')"`.
  Then `node scripts/smoke-live.mjs https://parkcast.<name>.workers.dev` passes with a fresh forecast.
- [ ] **Step 8: Confirm the open questions (§10)**, recording each answer in the Review section:
  1. `npm run deploy:preview` (its `wrangler triggers deploy` with `preview_urls: true` switches preview
     URLs on before the upload); the preview URL's `/artifacts/grid.bin` equals the live one (the preview
     reads production KV); after the next normal release — whose `wrangler triggers deploy` applies
     `preview_urls: false`, and whose final check confirms its own version's preview host does not
     answer `2xx` — that older preview URL no longer answers (§10.13).
  2. Dashboard Workers metrics: request count before and after 50 requests to random non-artifact paths
     — does `404-page` handling keep them off the Worker? Update spec §6.3 with the answer.
  3. `/_headers` is 404 and the §6.2 headers are on `/` (the smoke test covers both).
  4. The dashboard offers no firewall rules for workers.dev.
  5. (Done in Task 6.)
  6. The daily-limit and CPU-exceeded responses, from Cloudflare's error documentation (never by
     exhausting the real limit). If the daily-limit status is not `429`, change `UploadGuard.record`
     and its test to match exactly.
  7. (Done in Task 11B.)
  8. The app in the Browser pane: zero CSP violations in the console across first load, map pan and
     zoom, search, a destination tap, the language toggle, the time slider and an offline reload.
  9. After a few hours of uploads, the dashboard's CPU time for `PUT` requests. Above 10 ms, apply
     the §4.3 fallback.
  10. The dashboard shows observability off and no request logs.
  11. `wrangler secret put --help` and Cloudflare's docs: whether it deploys an undeployed version.
      Update the runbook.
  12. The collector log shows no `uploads disabled (no valid secret file)` line (compose secret readable).
  13. (With 1.)
  14. The user runs `Get-Module PSReadLine` and checks the history file has no token.
  15. `curl -sI -H "Accept-Encoding: gzip"` on `lots.json`: record the ETag form; confirm a
      revalidation with it returns `304`.
  16. (Done while planning.)
  17. Not used: the release smoke-tests after promotion and rolls back automatically.
  18. The permissions the working deploy key has, recorded in `docs/deploy.md` — including setting the
      Worker's workers.dev subdomain and preview-URL settings, which every release's `triggers deploy` needs.
- [ ] **Step 9: Record the live state** in `README.md` and `docs/state-of-play.md` (address, date,
  first upload), check `OOMKilled` after the first live midnight, and ask about committing and merging.

---

## Deferred beyond this plan

A custom domain and firewall rules (only if abuse appears); CI deploys from GitHub Actions; removing
frozen lots from climatology; the gap-aware liveness rule; compressing daily metadata snapshots; the
licence.

## Review

Tasks 1–12 executed 2026-09-14 on `feat/cloudflare-deploy`, subagent-driven, in place. **Nothing committed and nothing deployed.** Every task had a fresh implementer and a task review; seven needed one fix round (Tasks 3, 5, 9, 11, 12, plus rulings in 1 and 8); a final whole-branch review (opus) found one Critical and three Important issues, fixed in one wave and re-reviewed clean. The full ledger of rulings, deferred minors and parked items is in `.superpowers/sdd/todo/progress.md` (git-ignored).

**Final verification** (the staged tree, 72 files, +6,449/−133 against `6ebeefe`): Python 350 passed / 3 skipped; web 219, typecheck and lint clean; Worker 62, typecheck clean; scripts 32. The credential-free check phase passes every step except `missing required file: basemap/taipei.pmtiles` (rebuilt in Task 13). `deploy:release` refuses without a key. The live collector was never touched (StartedAt 2026-09-14T01:06:58Z, RestartCount 0). `core.hooksPath` is still unset.

**Measured during execution:** feed bodies 421,825 B and 2,883,343 B, no redirects; hardened rehearsal exit 0 as uid 10001 on a read-only root, memory.peak 265,166,848 B, pids.peak 6; Worker upload validation + hashing ~1.5 ms per upload in Node on the real 1,090-lot pair; wrangler 4.131.1's `deploy --dry-run`, `versions upload/deploy`, `rollback` and `triggers deploy` (experimental) exist as used.

**Found and fixed beyond the plan:** prune could delete an unarchived day (Task 1, existing bug); a bad secret file or URL would crash-loop the collector (Task 3); the pre-commit hook could be bypassed by a `+++`-shaped line (Task 5); a smoke-test exception skipped rollback, and pruning dry-run maps was unguarded (Task 11); the release never applied `workers_dev`/`preview_urls` — only `wrangler triggers deploy` does (final review); the non-root image broke the documented throwaway test containers (final review); `authorized()` let `Bearer ` through when the secret was missing (final review).

**Execution-time rulings that changed commands:** `node --test scripts/tests/*.test.mjs` (a bare directory runs nothing on Node 22/Windows); npm 10 ignores `--prefix` for install/ci/audit; throwaway `docker run` test containers need `--user 0:0` once the image is non-root.

**Open for Task 13** (in addition to §10): `triggers deploy` on the draft Worker `secret put` creates; what a disabled preview host returns; the deploy key's workers.dev subdomain/preview permission; `/scratch` writable by uid 10001; merge the compose snippet into the existing `environment:` block (the docs say "add"); do not rotate the secret right after a `deploy:preview` — release first.
