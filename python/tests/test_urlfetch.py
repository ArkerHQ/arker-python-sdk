"""`ADD <url>` must not become an SSRF against the machine running the build.

The fetch happens on the CLIENT (matching Docker, which downloads on the
builder). That is a much more interesting network position than the guest: a CI
runner can reach its own cloud metadata service and any loopback admin API. An
untrusted Dockerfile holds the trigger, and the same Dockerfile's RUN has the
egress to send the answer on.
"""

from __future__ import annotations

import pytest

from arker.urlfetch import UrlFetchError, fetch_url


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254/latest/meta-data/iam/security-credentials/",  # AWS IMDS
        "http://metadata.google.internal/computeMetadata/v1/",               # GCP
        "http://127.0.0.1:8500/v1/kv/prod",                                  # loopback admin API
        "http://localhost:10250/pods",                                       # kubelet
        "http://[::1]:8080/",
        "http://10.0.0.5/internal",
        "http://192.168.1.1/",
        "http://172.16.0.1/",
        "http://0.0.0.0/",
    ],
)
def test_non_public_addresses_are_refused(url):
    with pytest.raises(UrlFetchError, match="non-public|cannot resolve"):
        fetch_url(url, timeout=2)


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://internal.example/secrets",
        "gopher://127.0.0.1:6379/_SET%20x%20y",
        "dict://127.0.0.1:11211/stat",
    ],
)
def test_only_http_and_https_are_fetched(url):
    with pytest.raises(UrlFetchError, match="only http and https"):
        fetch_url(url, timeout=2)


def test_a_public_name_resolving_to_metadata_is_refused(monkeypatch):
    """The check has to be on the RESOLVED address, not the hostname.

    DNS is attacker-controlled for a URL the attacker wrote, so
    `cdn.evil.example` resolving to 169.254.169.254 is the obvious bypass of
    any name-based allowlist.
    """
    import socket as socket_mod

    import arker.urlfetch as uf

    monkeypatch.setattr(
        uf.socket,
        "getaddrinfo",
        lambda host, port, *a, **k: [
            (socket_mod.AF_INET, socket_mod.SOCK_STREAM, 6, "", ("169.254.169.254", 0))
        ],
    )
    with pytest.raises(UrlFetchError, match="non-public"):
        fetch_url("https://cdn.evil.example/tool.tgz", timeout=2)


def test_every_address_a_name_resolves_to_is_checked(monkeypatch):
    """One public answer must not launder a private one: we cannot control
    which address the connection ends up using."""
    import socket as socket_mod

    import arker.urlfetch as uf

    monkeypatch.setattr(
        uf.socket,
        "getaddrinfo",
        lambda host, port, *a, **k: [
            (socket_mod.AF_INET, socket_mod.SOCK_STREAM, 6, "", ("93.184.216.34", 0)),
            (socket_mod.AF_INET, socket_mod.SOCK_STREAM, 6, "", ("127.0.0.1", 0)),
        ],
    )
    with pytest.raises(UrlFetchError, match="non-public"):
        fetch_url("https://dual.example/x", timeout=2)
