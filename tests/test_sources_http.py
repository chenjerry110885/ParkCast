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
