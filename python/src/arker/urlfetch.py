"""Fetching an `ADD <url>` safely from the client.

`ADD` used to run `curl` inside the guest. Moving the fetch to the client
matched Docker (which downloads on the builder) and removed the need for curl
in the image — but it also moved the request onto the machine RUNNING the SDK,
which is a very different network position. A CI runner building an untrusted
repository can reach its own cloud metadata service, loopback admin APIs and
anything else on its private network. An unrestricted fetch there is a
server-side request forgery primitive with the Dockerfile author holding the
trigger, and the same Dockerfile's `RUN` has egress to send the answer on.

So this module exists to make that fetch boring:

* Only `http` and `https`. Not `file:`, not `ftp:` — and Python's redirect
  handler will happily follow a redirect to `ftp:`, so the scheme is checked on
  every hop rather than only on the URL the caller wrote.
* Every hop's host is resolved and refused if it lands on loopback,
  link-local (169.254/16 — cloud metadata), private, reserved or multicast
  space. Checking the literal is not enough: `attacker.example` can simply
  resolve to 169.254.169.254, and a public URL can redirect to it.
* A timeout and a size ceiling, so a slow or endless body cannot hang or
  exhaust the build.

None of this defends the guest, which the Dockerfile author already controls.
It defends the operator.
"""

from __future__ import annotations

import ipaddress
import socket
import urllib.error
import urllib.request
from urllib.parse import urlparse

__all__ = ["UrlFetchError", "fetch_url"]

#: Give up on a URL that will not answer. `urlopen`'s default is no timeout at
#: all, which turns a slowloris into a hung build.
DEFAULT_TIMEOUT_S = 30

#: Refuse a body larger than this. Read incrementally so a lying (or absent)
#: Content-Length cannot get past it.
MAX_BYTES = 512 * 1024 * 1024

#: A redirect chain longer than this is a loop or an attack, not a CDN.
MAX_REDIRECTS = 5


class UrlFetchError(Exception):
    """A URL this SDK will not fetch, with the reason named."""


def _refuse_internal_address(host: str) -> None:
    """Resolve `host` and refuse anything that is not public.

    Resolution is the point. A hostname is not a safe input just because it
    looks public: DNS is attacker-controlled for a URL the attacker wrote, so
    the address it actually resolves to is the only thing worth checking.
    Every address in the answer is checked, because a name can resolve to
    several and we cannot control which one the connection picks.
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as error:
        raise UrlFetchError(f"cannot resolve {host}: {error}") from error

    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if (
            address.is_loopback
            or address.is_link_local
            or address.is_private
            or address.is_reserved
            or address.is_multicast
            or address.is_unspecified
        ):
            raise UrlFetchError(
                f"refusing to fetch from {host} ({address}): it resolves to a "
                "non-public address. ADD downloads run on the machine building the "
                "Dockerfile, so a URL pointing at loopback, link-local (cloud "
                "metadata) or private space would read that machine's internal "
                "network on the Dockerfile author's behalf."
            )


def _check(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise UrlFetchError(
            f"refusing to fetch {parsed.scheme or url!r}: only http and https are "
            "supported for ADD"
        )
    if not parsed.hostname:
        raise UrlFetchError(f"no host in URL: {url}")
    _refuse_internal_address(parsed.hostname)


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """Stop `urlopen` following redirects so each hop can be vetted here."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


def fetch_url(
    url: str,
    *,
    timeout: float = DEFAULT_TIMEOUT_S,
    max_bytes: int = MAX_BYTES,
) -> bytes:
    """Download `url`, vetting every redirect hop. Raises `UrlFetchError`."""
    opener = urllib.request.build_opener(_NoRedirects)

    for _hop in range(MAX_REDIRECTS + 1):
        _check(url)
        try:
            response = opener.open(url, timeout=timeout)
        except urllib.error.HTTPError as error:
            if error.code in (301, 302, 303, 307, 308):
                location = error.headers.get("Location")
                if not location:
                    raise UrlFetchError(f"{url}: redirect with no Location") from error
                url = urllib.parse.urljoin(url, location)
                continue
            raise UrlFetchError(f"{url}: HTTP {error.code} {error.reason}") from error
        except OSError as error:
            raise UrlFetchError(f"{url}: {error}") from error

        with response:
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise UrlFetchError(
                        f"{url}: response exceeds the {max_bytes} byte limit for ADD"
                    )
                chunks.append(chunk)
            return b"".join(chunks)

    raise UrlFetchError(f"{url}: more than {MAX_REDIRECTS} redirects")
