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


def test_load_secret_refuses_undecodable_bytes(tmp_path):
    path = tmp_path / "s"
    path.write_bytes(b"\xff\xfe\x00")
    assert upload.load_secret(path) is None


def test_load_secret_refuses_the_wrong_encoding(tmp_path):
    path = tmp_path / "s"
    path.write_text(SECRET, encoding="utf-16")
    assert upload.load_secret(path) is None


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
        f"https://{HOST}:abc/artifacts/latest",
        f"https://[{HOST}/artifacts/latest",
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


def test_send_pair_names_itself_instead_of_python_urllib(server):
    # Cloudflare's edge answers urllib's default user agent with 403 "error code: 1010".
    upload.send_pair(server + "/artifacts/latest", SECRET, b"G", b"L",
                     opener=upload.build_opener(), timeout=5)
    _, headers, _ = _Handler.seen[0]
    assert headers["User-Agent"] == config.UPLOAD_USER_AGENT
    assert "Python-urllib" not in headers["User-Agent"]


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


# --- the week table: its own request, never send_pair's ----------------------

def test_send_week_puts_to_its_own_path_with_headers(server):
    """Its own request: a different path than the pair's, its own body, its
    own X-Roster-Id -- but the same opener, user agent and secret handling."""
    status, reject, _ = upload.send_week(server + "/artifacts/latest", SECRET, b"WEEKBYTES",
                                         city="taipei", roster_id=42,
                                         opener=upload.build_opener(), timeout=5)
    assert (status, reject) == (204, None)
    path, headers, body = _Handler.seen[0]
    assert path == "/artifacts/week.bin", "taipei keeps the unsuffixed name, like grid.bin"
    assert body == b"WEEKBYTES"
    assert headers["X-Roster-Id"] == "42"
    assert headers["Authorization"] == f"Bearer {SECRET}"
    assert headers["User-Agent"] == config.UPLOAD_USER_AGENT


def test_send_week_uses_the_citys_own_filename(server):
    upload.send_week(server + "/artifacts/latest", SECRET, b"W", city="tainan", roster_id=1,
                     opener=upload.build_opener(), timeout=5)
    path, _, _ = _Handler.seen[0]
    assert path == "/artifacts/week-tainan.bin"


def test_send_week_reports_rejections(server):
    _Handler.status = 409
    _Handler.extra_headers = {"X-Reject": "roster-shrink"}
    status, reject, _ = upload.send_week(server + "/artifacts/latest", SECRET, b"W",
                                         city="taipei", roster_id=1,
                                         opener=upload.build_opener(), timeout=5)
    assert (status, reject) == (409, "roster-shrink")


def test_send_week_refuses_redirects_and_never_forwards_the_secret(server):
    _Handler.status = 307
    _Handler.extra_headers = {"Location": server + "/elsewhere"}
    status, _, _ = upload.send_week(server + "/artifacts/latest", SECRET, b"W",
                                    city="taipei", roster_id=1,
                                    opener=upload.build_opener(), timeout=5)
    assert status == 307
    assert [p for p, _, _ in _Handler.seen] == ["/artifacts/week.bin"]


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


def _upload_record_for_409(caplog, reject):
    def rejecting_send(url, secret, grid, lots, *, opener, timeout):
        return 409, reject, None

    up = _uploader(rejecting_send)
    up.offer(b"one", b"L", base_data_ts=1, roster_id=7)
    with caplog.at_level(logging.DEBUG, logger="parkcast.upload"):
        assert up.process_pending()
    [record] = [r for r in caplog.records if r.name == "parkcast.upload"]
    return record


@pytest.mark.parametrize("reject", ["stale", "too-soon"])
def test_a_409_for_a_reading_already_covered_is_info(caplog, reject):
    record = _upload_record_for_409(caplog, reject)
    assert record.levelno == logging.INFO
    assert record.getMessage().startswith(f"upload not needed: status=409 reject={reject} duration=")
    assert record.getMessage().endswith(" bytes=4")


@pytest.mark.parametrize("reject, token", [
    ("future", "future"), ("too-old", "too-old"), ("roster-shrink", "roster-shrink"),
    ("<script>", "unknown"), (None, "unknown"),
])
def test_a_409_that_refuses_the_reading_itself_is_a_warning(caplog, reject, token):
    record = _upload_record_for_409(caplog, reject)
    assert record.levelno == logging.WARNING
    message = record.getMessage()
    assert message.startswith(f"upload rejected: {token} status=409 duration=")
    assert message.endswith(" bytes=4")
    assert "<script>" not in caplog.text


def _uploader_week(send_week, **kwargs):
    return upload.Uploader(URL, SECRET, send_week=send_week, week_guard=upload.UploadGuard(),
                           **kwargs)


def test_offer_week_calls_send_week_with_the_published_bytes():
    calls = []

    def fake_send_week(url, secret, week, *, city, roster_id, opener, timeout):
        calls.append((url, secret, week, city, roster_id))
        return 204, None, None

    up = _uploader_week(fake_send_week)
    up.offer_week(b"WEEKBYTES", city="taipei", roster_id=99)
    assert up.process_pending_week()
    assert calls == [(URL, SECRET, b"WEEKBYTES", "taipei", 99)]


def test_offer_week_never_blocks_and_only_the_latest_waits():
    release = threading.Event()
    sent = []

    def slow_send_week(url, secret, week, *, city, roster_id, opener, timeout):
        sent.append(week)
        release.wait(5)
        return 204, None, None

    up = _uploader_week(slow_send_week).start()
    started = time.monotonic()
    up.offer_week(b"one", city="taipei", roster_id=1)
    time.sleep(0.2)
    up.offer_week(b"two", city="taipei", roster_id=1)
    up.offer_week(b"three", city="taipei", roster_id=1)
    assert time.monotonic() - started < 1.0
    release.set()
    deadline = time.monotonic() + 5
    while len(sent) < 2 and time.monotonic() < deadline:
        time.sleep(0.05)
    assert sent == [b"one", b"three"]


def test_a_week_upload_failure_does_not_touch_the_pairs_guard_or_job(caplog):
    """`send_week` must not ride `send_pair`'s job: its own request and its
    own back-off, so a failing week upload cannot pause or skip the pair's
    next attempt, and vice versa."""
    pair_calls = []
    week_calls = []

    def fake_send(url, secret, grid, lots, *, opener, timeout):
        pair_calls.append((grid, lots))
        return 204, None, None

    def failing_send_week(url, secret, week, *, city, roster_id, opener, timeout):
        week_calls.append(week)
        raise RuntimeError("boom")

    up = upload.Uploader(URL, SECRET, send=fake_send, send_week=failing_send_week,
                         guard=upload.UploadGuard(), week_guard=upload.UploadGuard())

    up.offer_week(b"W", city="taipei", roster_id=1)
    with caplog.at_level(logging.WARNING, logger="parkcast.upload"):
        assert up.process_pending_week()
    assert "week upload failed" in caplog.text
    assert week_calls == [b"W"]

    up.offer(b"G", b"L", base_data_ts=1, roster_id=7)
    assert up.process_pending()
    assert pair_calls == [(b"G", b"L")], "the pair must still attempt normally"


def test_a_week_upload_in_flight_does_not_block_a_pair_attempt():
    """`_helper_week` must be tracked separately from `_helper`: a slow week
    send in flight must not make the pair's own "previous attempt still
    running" check trip. A failing send (the test above) proves the two
    guards are separate but not this -- `failing_send_week` raises
    immediately, so its helper thread is already dead by the time the pair
    is attempted and `is_alive()` never gets a chance to trip either way."""
    week_release = threading.Event()
    week_started = threading.Event()
    pair_calls = []

    def hanging_send_week(url, secret, week, *, city, roster_id, opener, timeout):
        week_started.set()
        week_release.wait(5)
        return 204, None, None

    def fake_send(url, secret, grid, lots, *, opener, timeout):
        pair_calls.append((grid, lots))
        return 204, None, None

    up = upload.Uploader(URL, SECRET, send=fake_send, send_week=hanging_send_week,
                         guard=upload.UploadGuard(), week_guard=upload.UploadGuard())
    up.offer_week(b"W", city="taipei", roster_id=1)
    week_thread = threading.Thread(target=up.process_pending_week, daemon=True)
    week_thread.start()
    try:
        assert week_started.wait(5), "the week send must actually be in flight"

        up.offer(b"G", b"L", base_data_ts=1, roster_id=7)
        up.process_pending()
        # A shared `_helper` would make `_attempt` see the week's in-flight
        # thread as "previous attempt still running" and skip `fake_send`
        # entirely, leaving this empty.
        assert pair_calls == [(b"G", b"L")]
    finally:
        week_release.set()
        week_thread.join(5)


def test_offer_week_retries_the_same_blob_until_accepted():
    """Major-1 fix: the week lane must retry a failed upload on the guard's
    own tick-calibrated back-off (offering the day's unchanged blob again
    each tick, exactly as `scheduler._publish_week` now does) rather than
    waiting for tomorrow's rebuild -- and once accepted, re-offering the
    identical bytes must cost no further network call at all."""
    attempts = []

    def flaky_send_week(url, secret, week, *, city, roster_id, opener, timeout):
        attempts.append(week)
        return (500, None, None) if len(attempts) < 2 else (204, None, None)

    up = upload.Uploader(URL, SECRET, send_week=flaky_send_week, week_guard=upload.UploadGuard())

    up.offer_week(b"TODAY", city="taipei", roster_id=1)   # tick 1: fails
    assert up.process_pending_week()
    assert attempts == [b"TODAY"]

    up.offer_week(b"TODAY", city="taipei", roster_id=1)   # tick 2: backing off
    assert up.process_pending_week()
    assert attempts == [b"TODAY"], "one tick of back-off after the first failure"

    up.offer_week(b"TODAY", city="taipei", roster_id=1)   # tick 3: retried, lands
    assert up.process_pending_week()
    assert attempts == [b"TODAY", b"TODAY"]

    up.offer_week(b"TODAY", city="taipei", roster_id=1)   # tick 4: already landed
    assert up.process_pending_week()
    assert attempts == [b"TODAY", b"TODAY"], "an accepted day's blob is a no-op duplicate"


def _week_upload_record_for(caplog, status, reject):
    def week_send(url, secret, week, *, city, roster_id, opener, timeout):
        return status, reject, None

    up = _uploader_week(week_send)
    up.offer_week(b"W", city="taipei", roster_id=1)
    with caplog.at_level(logging.DEBUG, logger="parkcast.upload"):
        assert up.process_pending_week()
    [record] = [r for r in caplog.records if r.name == "parkcast.upload"]
    return record


def test_a_week_409_names_roster_mismatch_instead_of_unknown(caplog):
    """Fix round 1, Major 1: `roster-mismatch` is the only token the week
    lane can ever emit as a 409 (see checkWeekRoster in worker/src/validate.ts),
    so it must be in KNOWN_REJECTS -- otherwise every week rejection logs as
    `unknown`, erasing the one diagnostic X-Reject exists to carry."""
    record = _week_upload_record_for(caplog, 409, "roster-mismatch")
    assert record.levelno == logging.WARNING
    assert record.getMessage().startswith("week upload rejected: roster-mismatch status=409")


def test_a_week_503_no_pair_is_visible_and_reads_as_self_resolving(caplog):
    """Fix round 1, Major 2: a cold-start 503 must be logged -- not silently
    swallowed into the generic "failed" branch -- and worded so it does not
    read as a fault. It is the expected state before the very next
    five-minute pair upload lands, not an error to chase."""
    record = _week_upload_record_for(caplog, 503, "no-pair")
    assert record.levelno == logging.WARNING
    message = record.getMessage()
    assert "no-pair" in message
    assert "failed" not in message.lower()


def test_from_environment_is_off_and_says_so_once_without_the_value(tmp_path, caplog, host):
    with caplog.at_level(logging.INFO, logger="parkcast.upload"):
        assert upload.from_environment({}, secret_path=tmp_path / "none") is None
    assert "uploads disabled" in caplog.text


def test_from_environment_builds_a_started_uploader(tmp_path, host):
    path = tmp_path / "s"
    path.write_text(SECRET, encoding="utf-8")
    up = upload.from_environment({config.UPLOAD_URL_ENV: URL}, secret_path=path)
    assert isinstance(up, upload.Uploader)


def test_from_environment_survives_load_secret_raising(monkeypatch, tmp_path, caplog, host):
    def boom(path):
        raise RuntimeError("boom " + SECRET)

    monkeypatch.setattr(upload, "load_secret", boom)
    with caplog.at_level(logging.INFO, logger="parkcast.upload"):
        result = upload.from_environment({config.UPLOAD_URL_ENV: URL}, secret_path=tmp_path / "s")
    assert result is None
    assert SECRET not in caplog.text
