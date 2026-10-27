from parkcast.sources import http


def test_post_json_sends_an_explicit_content_length(monkeypatch):
    seen = {}
    class FakeResponse:
        status_code = 200
        is_redirect = False
        headers = {"Content-Length": "2"}
        def raise_for_status(self): pass
        def iter_content(self, chunk_size): yield b"{}"
        def __enter__(self): return self
        def __exit__(self, *a): return False
    def fake_post(url, **kwargs):
        seen.update(kwargs); seen["url"] = url
        return FakeResponse()
    monkeypatch.setattr(http.requests, "post", fake_post)

    assert http.post_json("https://example.test/x") == {}
    # New Taipei answers 411 without it.
    assert seen["headers"]["Content-Length"] == "0"
    assert seen["headers"]["User-Agent"] == "parkcast-collector/1"
    assert seen["allow_redirects"] is False


def test_get_bytes_returns_the_body_unparsed_under_the_same_guards(monkeypatch):
    """Taipei's feed is XML now, so the transport hands back bytes and the
    source parses them. The guards are the ones `get_json` has always had:
    streamed, no redirects, the collector's User-Agent."""
    seen = {}
    class FakeResponse:
        status_code = 200
        is_redirect = False
        headers = {"Content-Length": "6"}
        def raise_for_status(self): pass
        def iter_content(self, chunk_size): yield b"<x/>\n"
        def __enter__(self): return self
        def __exit__(self, *a): return False
    def fake_get(url, **kwargs):
        seen.update(kwargs)
        return FakeResponse()
    monkeypatch.setattr(http.requests, "get", fake_get)

    assert http.get_bytes("https://example.test/x.xml") == b"<x/>\n"
    assert seen["allow_redirects"] is False
    assert seen["stream"] is True
    assert seen["headers"]["User-Agent"] == "parkcast-collector/1"
