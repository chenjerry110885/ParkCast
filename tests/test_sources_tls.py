"""Per-source TLS policy: what each source asks for, and what it still enforces.

Three of six feeds could not be verified from inside the collector image and
now opt out of one narrow thing each. The danger with a fix like that is not
that it fails -- a failure is loud -- but that it succeeds too broadly: a
relaxation applied globally would turn every one of this project's other
tests green while quietly unverifying three healthy feeds and Taipei. So the
first test here is the one that matters most, and several of the others exist
to pin the *shape* of the relaxation rather than its effect.
"""
import ast
import hashlib
import ssl
import struct
import time
from pathlib import Path

import certifi
import pytest

from parkcast.sources import hsinchu, http, kaohsiung, newtaipei, tainan, taipei, taoyuan

# A PUBLIC certificate, and only a certificate: no private key is committed
# anywhere in this repo. It was generated once with `openssl req -x509` on
# 2026-09-17, the key was destroyed in the same command that made it, and none
# is needed -- `_present_certificate` below drives OpenSSL's verification
# without a TLS peer, so nothing ever has to prove possession of this key.
#
# `.invalid` is the RFC 2606 reserved TLD, it is self-signed by a key that no
# longer exists, and it is in no trust store on earth. It is valid until 2126,
# so it will not become a mystery failure.
UNTRUSTED_CERT_PEM = """\
-----BEGIN CERTIFICATE-----
MIIDeDCCAmCgAwIBAgIUS2z1Oyys3BaMOIPc4nhho/fucRIwDQYJKoZIhvcNAQEL
BQAwJTEjMCEGA1UEAwwadW50cnVzdGVkLnBhcmtjYXN0LmludmFsaWQwIBcNMjYw
OTE3MDA0MDMwWhgPMjEyNjA4MjQwMDQwMzBaMCUxIzAhBgNVBAMMGnVudHJ1c3Rl
ZC5wYXJrY2FzdC5pbnZhbGlkMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC
AQEA2jPZIS3NzKONtbEuXFKFgyAUl5N4EeDD5BUS2oOWm+uA6s7G9lB3I6UywDzH
vW6Cf8/bt8wUvT53uyacffAGDn5iMel1a+a8SdGHamfGPigrueZvIUnHwzRkNoYb
VLcLDINrd0KdSL8dnowt3Xu+XcBa6Tp+OXfG+3Q8b4TpVB6BtbBqxRjJVrLH2r3y
d07tIYFk+GGeW+zzFVDPwdRKVlWX5rcCz+6NsK1nV++RohSkrcBUBqd0RZ3OXu3/
e97iMeYHqpfP6Ut3M++h9PU2keZ4FC9MUGwUBGBmtd0GBo9fO5KeRWXquPb7JVvw
KXenGJ3ZZfMT2UCGuj4YsaB9kQIDAQABo4GdMIGaMB0GA1UdDgQWBBRdSfLdoI3A
x7SWSzua3+nr/hgUmDAfBgNVHSMEGDAWgBRdSfLdoI3Ax7SWSzua3+nr/hgUmDAl
BgNVHREEHjAcghp1bnRydXN0ZWQucGFya2Nhc3QuaW52YWxpZDAMBgNVHRMBAf8E
AjAAMA4GA1UdDwEB/wQEAwIFoDATBgNVHSUEDDAKBggrBgEFBQcDATANBgkqhkiG
9w0BAQsFAAOCAQEAo9urLz7BsrNi4TJjhmpFh1st1nDdAyM8JTN1ZmWD6jNS/D2O
/2MFw78tXKewIDKxiVWPJyRcFiBe3K3rjqMjY2gzoT3K06hj/t3Wu+QbQUvq0MIV
A1IjIVXaG+cqC/LwGzPNbL/k0pCowfXYUywhBb359sw3R4Jml6Gm2WTJeYxAZWEi
Nu447YQZEF8tyM3ptMhpnlzbrfH+X0NhWmkI0R6uEqXeYf/H6unO9cMTx05xyqDb
dn3BC2JIQ4E3N4b7QSYXHUzUSGtFQEWTKAcVxXqP5ZHktBEAQJzVfLpXJkVTiT/z
0rl9eSoypeQzE67gaFnBWNN1KKThzHpqBfM7YA==
-----END CERTIFICATE-----
"""
UNTRUSTED_HOST = "untrusted.parkcast.invalid"

# Pinned from the certificate as fetched from its AIA URL on 2026-09-17 and
# recorded in the .pem's own header block. Pinned, not merely "some CA parses",
# so that replacing the file -- a rotation, a mis-paste, a substitution --
# fails here and sends whoever did it back to re-run the provenance checks
# rather than shipping an unexamined trust input.
CA_SHA256 = "01af2324d098098f5e0cdf6faabada430b21cce777f47eacb26248b2fda3e531"
CA_SERIAL = "400134B04F0000000000000003E324AC"
CA_SUBJECT_CN = "TWCA SSL Certification Authority"
CA_ISSUER_CN = "TWCA CYBER Root CA"


def _common_name(rdns) -> str:
    """The commonName out of `get_ca_certs()`'s nested RDN tuples."""
    for rdn in rdns:
        for key, value in rdn:
            if key == "commonName":
                return value
    return ""


def _loaded_cas(*, cafile: str) -> list[dict]:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(cafile=cafile)
    return context.get_ca_certs()


# --------------------------------------------------------------------------
# The regression that matters most: nothing is relaxed unless it asks to be.
# --------------------------------------------------------------------------

def test_a_policy_that_asks_for_nothing_is_fully_strict():
    """The default `TlsPolicy` must produce a strict context.

    This is the guard against the whole class of "make it work" fixes. If
    somebody relaxed `tls_context` unconditionally, every other test in this
    repo would still pass -- including the ones below that assert Kaohsiung's
    relaxed context behaves correctly -- and six feeds would silently lose a
    verification step. Only this assertion notices.

    It is not a hypothetical branch, either: New Taipei's live policy leaves
    `x509_strict` at its default, so this is the code path that decides
    whether a production source verifies strictly.
    """
    context = http.tls_context(http.TlsPolicy())

    assert context.verify_flags & ssl.VERIFY_X509_STRICT
    assert context.verify_mode is ssl.CERT_REQUIRED
    assert context.check_hostname is True


def test_the_no_policy_transport_path_is_requests_own_strict_context():
    """A source that passes no `tls=` still gets a strict context.

    `STRICT` is not routed through `tls_context` at all -- it takes the plain
    `requests.get`/`requests.post` path, deliberately unchanged. That is only
    safe while `requests`' own default context is strict, which was measured
    on this image (urllib3 2.8.0) and is asserted here so a dependency bump
    that drops the flag fails the suite instead of silently changing what
    four sources enforce.
    """
    from urllib3.util.ssl_ import create_urllib3_context

    default = create_urllib3_context()
    assert default.verify_flags & ssl.VERIFY_X509_STRICT
    assert default.verify_mode is ssl.CERT_REQUIRED
    assert default.check_hostname is True


@pytest.mark.parametrize("module", [taipei, tainan, taoyuan])
def test_the_healthy_sources_declare_no_policy_at_all(module):
    """Taipei, Tainan and Taoyuan verify cleanly and must stay untouched."""
    assert not hasattr(module, "TLS")


def test_only_three_sources_opt_out_and_each_opts_out_of_one_thing():
    """The exact shape of the fix, spelled out where a reviewer can see it."""
    # Kaohsiung and Hsinchu: the flag, and nothing else. `extra_ca_file` stays
    # None -- neither needs a certificate we do not already trust.
    assert kaohsiung.TLS == http.TlsPolicy(x509_strict=False)
    assert hsinchu.TLS == http.TlsPolicy(x509_strict=False)
    # New Taipei: the missing intermediate, and STRICT STAYS ON.
    assert newtaipei.TLS == http.TlsPolicy(extra_ca_file=http.TWCA_SSL_CA)
    assert newtaipei.TLS.x509_strict is True


def _disables_verification(tree: ast.AST) -> bool:
    """Does this module contain code that turns certificate checking off?

    An AST walk rather than a grep, so that prose *about* the forbidden forms
    -- this project documents them at length precisely because they are what
    a hurried fix reaches for -- does not trip it, while the forms themselves
    cannot hide behind spacing, line breaks or an alias.
    """
    for node in ast.walk(tree):
        if isinstance(node, ast.keyword) and node.arg == "verify":
            if isinstance(node.value, ast.Constant) and node.value.value is False:
                return True
        if isinstance(node, ast.Attribute) and node.attr == "CERT_NONE":
            return True
        if isinstance(node, ast.Name) and node.id == "CERT_NONE":
            return True
        if isinstance(node, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            named = any(
                (isinstance(t, ast.Attribute) and t.attr == "check_hostname")
                or (isinstance(t, ast.Name) and t.id == "check_hostname")
                for t in targets
            )
            value = getattr(node, "value", None)
            if named and isinstance(value, ast.Constant) and value.value is False:
                return True
    return False


def test_nothing_in_the_package_can_turn_verification_off():
    """No `verify=False`, no `CERT_NONE`, no `check_hostname = False` anywhere.

    Deliberately not scoped to this module. The whole point of a per-source
    policy is that the tempting one-line "fix" stays unavailable, so this
    fails the suite the moment someone reaches for it anywhere in `src/` --
    including in a source adapter that never imports this transport.
    """
    root = Path(__file__).parent.parent
    offenders = [
        str(path.relative_to(root))
        for path in (root / "src").rglob("*.py")
        if _disables_verification(ast.parse(path.read_text(encoding="utf-8")))
    ]
    assert offenders == []


# --------------------------------------------------------------------------
# The relaxation is narrow, and still rejects what it should.
# --------------------------------------------------------------------------

def test_the_relaxed_context_clears_only_the_strict_flag():
    strict = http.tls_context(http.TlsPolicy())
    relaxed = http.tls_context(http.TlsPolicy(x509_strict=False))

    # Exactly one bit differs, and it is that one.
    assert strict.verify_flags ^ relaxed.verify_flags == ssl.VERIFY_X509_STRICT
    assert not relaxed.verify_flags & ssl.VERIFY_X509_STRICT
    # Everything that actually decides trust is untouched.
    assert relaxed.verify_mode is ssl.CERT_REQUIRED
    assert relaxed.check_hostname is True
    # And no anchor was added: the same roots, no more.
    assert relaxed.cert_store_stats() == strict.cert_store_stats()


def _present_certificate(context: ssl.SSLContext, pem: str, *, hostname: str):
    """Make `context` verify `pem` as a server's certificate. Returns the error.

    WHY THIS EXISTS RATHER THAN A TLS SERVER. Proving that a context still
    *rejects* something requires driving real OpenSSL verification, and the
    obvious way -- a loopback TLS server -- needs a server private key. A key
    in this repo would mean carving a named hole in `.gitignore`'s blanket
    `*.pem` ("Never commit these"), which is how a deliberate guard stops
    meaning anything, and it would trip secret scanners on every push for
    someone to investigate and conclude it was fine.

    None is needed. A TLS client validates the server's certificate chain
    when it processes the Certificate message, which in TLS 1.2 arrives in
    the clear and *before* the server has proved possession of anything. So
    this hand-writes just enough of a server flight -- a ServerHello naming a
    cipher suite the client offered, then the Certificate message -- and feeds
    it to a client `SSLObject` over a `MemoryBIO`. OpenSSL verifies, and
    raises. Nothing secret is involved, nothing listens on a port, no thread
    runs, and the result is deterministic.

    Returns the exception rather than raising, so callers can assert on both
    the failures and the non-failures.
    """
    incoming, outgoing = ssl.MemoryBIO(), ssl.MemoryBIO()
    connection = context.wrap_bio(incoming, outgoing, server_hostname=hostname)
    try:
        connection.do_handshake()
    except ssl.SSLWantReadError:
        pass  # expected: the ClientHello is written, nothing has answered yet
    client_hello = outgoing.read()

    # Walk the ClientHello to the cipher-suite list: 5 bytes of record header,
    # 4 of handshake header, 2 of legacy_version, 32 of random, then a
    # length-prefixed session id.
    at = 5 + 4 + 2 + 32
    at += 1 + client_hello[at]
    count = struct.unpack(">H", client_hello[at:at + 2])[0]
    at += 2
    offered = {struct.unpack(">H", client_hello[at + n:at + n + 2])[0]
               for n in range(0, count, 2)}
    # Any suite the client offered will do; the handshake never gets far
    # enough to use it. ECDHE-RSA-AES128-GCM-SHA256 is in every default list.
    suite = 0xC02F if 0xC02F in offered else sorted(offered)[0]

    def record(payload: bytes) -> bytes:
        return b"\x16\x03\x03" + struct.pack(">H", len(payload)) + payload

    def handshake(kind: int, body: bytes) -> bytes:
        return bytes([kind]) + len(body).to_bytes(3, "big") + body

    # ServerHello: TLS 1.2, a fixed random, no session id, the chosen suite,
    # no compression, and an empty renegotiation_info -- which OpenSSL clients
    # require before they will look at anything else.
    server_hello = handshake(2, (
        b"\x03\x03" + bytes(32) + b"\x00" + struct.pack(">H", suite) + b"\x00"
        + struct.pack(">H", 5) + b"\xff\x01\x00\x01\x00"
    ))
    der = ssl.PEM_cert_to_DER_cert(pem)
    entry = len(der).to_bytes(3, "big") + der
    certificate = handshake(11, len(entry).to_bytes(3, "big") + entry)

    incoming.write(record(server_hello))
    incoming.write(record(certificate))
    try:
        connection.do_handshake()
    except ssl.SSLError as error:
        return error
    return None


@pytest.mark.parametrize("policy, label", [
    (http.TlsPolicy(x509_strict=False), "kaohsiung and hsinchu"),
    (http.TlsPolicy(), "every source that declares nothing"),
    (newtaipei.TLS, "newtaipei, which also gained a CA"),
])
def test_every_policy_still_rejects_an_untrusted_certificate(policy, label):
    """Proof that no policy here became "trust everything".

    Run against all three shapes, not just the relaxed one: clearing
    `VERIFY_X509_STRICT` is the obvious place to over-reach, but so is adding
    a CA file, and a context that skipped verification would sail through
    every other test in this repo.

    Asserted on `verify_code` rather than message text, so this pins a *trust*
    refusal -- 18/19 are OpenSSL's self-signed verdicts -- rather than, say, a
    hostname mismatch that would have failed for the wrong reason.

    Checked by doing the damage on purpose: replacing the context under test
    with `verify_mode = CERT_NONE` makes this the assertion that fails, and
    only this one.
    """
    error = _present_certificate(http.tls_context(policy), UNTRUSTED_CERT_PEM,
                                 hostname=UNTRUSTED_HOST)

    assert isinstance(error, ssl.SSLCertVerificationError), label
    assert error.reason == "CERTIFICATE_VERIFY_FAILED"
    # 18 = DEPTH_ZERO_SELF_SIGNED_CERT, 19 = SELF_SIGNED_CERT_IN_CHAIN.
    assert error.verify_code in (18, 19)


def test_the_relaxed_context_accepts_a_certificate_it_should_trust():
    """The control: the refusal above is about trust, not about breakage.

    Same relaxed policy, same certificate, same harness -- but with that
    certificate in this one context's store, verification passes and the
    handshake goes on to want the rest of the server flight that
    `_present_certificate` never sends. Without this, a context that rejected
    *everything*, or a harness that was simply broken, would pass the test
    above and look like proof of good behaviour.
    """
    relaxed = http.tls_context(http.TlsPolicy(x509_strict=False))
    relaxed.load_verify_locations(cadata=UNTRUSTED_CERT_PEM)

    error = _present_certificate(relaxed, UNTRUSTED_CERT_PEM, hostname=UNTRUSTED_HOST)

    assert not isinstance(error, ssl.SSLCertVerificationError)
    assert isinstance(error, ssl.SSLWantReadError)


# --------------------------------------------------------------------------
# The extra CA is additive, and is the certificate it claims to be.
# --------------------------------------------------------------------------

def test_the_extra_ca_context_trusts_the_normal_roots_as_well_as_the_added_one():
    """New Taipei must gain one anchor, not swap its trust store for one."""
    strict = http.tls_context(http.TlsPolicy())
    extra = http.tls_context(newtaipei.TLS)

    assert extra.cert_store_stats()["x509_ca"] == strict.cert_store_stats()["x509_ca"] + 1

    subjects = {_common_name(cert["subject"]) for cert in extra.get_ca_certs()}
    assert CA_SUBJECT_CN in subjects
    # Still the ordinary web PKI: the intermediate's own issuer, and an
    # unrelated root that has nothing to do with Taiwan, are both still there.
    assert CA_ISSUER_CN in subjects
    assert "ISRG Root X1" in subjects
    # And New Taipei did not quietly buy a relaxation along with the CA.
    assert extra.verify_flags & ssl.VERIFY_X509_STRICT


def test_the_extra_ca_is_no_new_trust_anchor_its_issuer_is_already_trusted():
    """The whole safety argument for shipping this file, as an assertion.

    Supplying an intermediate only lets a path be *completed*; it grants
    nothing, because the root it chains to -- `TWCA CYBER Root CA` -- is
    already in certifi. If a future certifi drops that root, this fails, and
    shipping the intermediate would from then on be a real trust decision
    someone has to make deliberately.
    """
    certifi_subjects = {_common_name(cert["subject"])
                        for cert in _loaded_cas(cafile=certifi.where())}
    assert CA_ISSUER_CN in certifi_subjects
    assert CA_SUBJECT_CN not in certifi_subjects  # it is genuinely missing


def test_the_shipped_intermediate_is_the_certificate_it_claims_to_be():
    assert http.TWCA_SSL_CA.exists()

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(cafile=str(http.TWCA_SSL_CA))
    certs = context.get_ca_certs()
    # One certificate, not a bundle somebody appended to.
    assert len(certs) == 1
    assert _common_name(certs[0]["subject"]) == CA_SUBJECT_CN
    assert _common_name(certs[0]["issuer"]) == CA_ISSUER_CN
    assert certs[0]["serialNumber"] == CA_SERIAL

    der = context.get_ca_certs(binary_form=True)[0]
    assert hashlib.sha256(der).hexdigest() == CA_SHA256


def test_the_shipped_intermediate_is_inside_its_validity_window():
    """Fails on the day it expires, which is the point.

    A CA file that quietly goes out of date turns into New Taipei failing
    every tick with an SSLError nobody has a name for. This test is the thing
    that says the name first -- and it is the only warning there will be, so
    it is deliberately an assertion and not a log line.
    """
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(cafile=str(http.TWCA_SSL_CA))
    cert = context.get_ca_certs()[0]

    now = time.time()
    assert ssl.cert_time_to_seconds(cert["notBefore"]) <= now, cert["notBefore"]
    assert now < ssl.cert_time_to_seconds(cert["notAfter"]), (
        f"the shipped TWCA intermediate expired on {cert['notAfter']}: fetch the "
        f"current one from the leaf's AIA URL, re-run the provenance checks in "
        f"the .pem's header, and update the pins in this file"
    )


def test_a_missing_extra_ca_file_fails_loudly_rather_than_silently():
    """No silent degradation to "verify with whatever we happen to have"."""
    with pytest.raises(OSError):
        http.tls_context(http.TlsPolicy(extra_ca_file=Path("no-such-ca.pem")))


# --------------------------------------------------------------------------
# The wiring: each adapter actually hands its policy to the transport.
# --------------------------------------------------------------------------

@pytest.mark.parametrize("module, verb, payload, expected", [
    (kaohsiung, "post_json", {"parkingLots": []}, "kaohsiung"),
    (hsinchu, "get_json", [], "hsinchu"),
    (newtaipei, "post_json", [], "newtaipei"),
    (tainan, "get_json", [], None),
    (taoyuan, "get_json", [], None),
    (taipei, "get_json", {"data": {"UPDATETIME": "Fri Sep 04 09:08:00 CST 2026", "park": []}}, None),
])
def test_each_adapter_hands_the_transport_its_own_policy(
    monkeypatch, module, verb, payload, expected
):
    """A policy declared but not passed would fix nothing and look fixed."""
    seen = {}

    def fake(url, **kwargs):
        seen["tls"] = kwargs.get("tls", http.STRICT)
        return payload

    monkeypatch.setattr(http, verb, fake)
    module.Source().fetch(now=1_760_000_000)

    assert seen["tls"] == (module.TLS if expected else http.STRICT)
