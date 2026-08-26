"""Query-string serialisation.

`_build_query` used `str(value)`, which renders Python bools as `True`/`False`.
The API decodes them with serde, which accepts only `true`/`false`, so every
boolean query parameter was rejected:

    GET /v1/vms?public=True
    400 bad_request: listVms query could not be decoded:
        Failed to deserialize query string: public: provided string was not
        `true` or `false`

Confirmed against a live feature env: `public=true` -> 200, `public=True` -> 400.
That made `list_vms(public=True)` — the documented way to list public goldens —
impossible from the Python SDK.
"""

from __future__ import annotations

import arker.computer as sdk
from arker.generated.api_models import ListVmsParameters


def test_booleans_serialise_lowercase() -> None:
    path = sdk._build_query("/v1/vms", ListVmsParameters(public=True))
    assert "public=true" in path, path
    assert "public=True" not in path, path


def test_false_serialises_lowercase_too() -> None:
    path = sdk._build_query("/v1/vms", ListVmsParameters(public=False))
    assert "public=false" in path, path
    assert "public=False" not in path, path


def test_non_bools_are_unchanged() -> None:
    """Only bools change shape; ints and strings must serialise as before."""
    path = sdk._build_query(
        "/v1/vms", ListVmsParameters(limit=25, org_id="ArkerHQ", public=True)
    )
    assert "limit=25" in path, path
    assert "org_id=ArkerHQ" in path, path


def test_none_is_still_dropped() -> None:
    """An unset parameter must not appear at all, rather than as `none`."""
    path = sdk._build_query("/v1/vms", ListVmsParameters(public=None, limit=5))
    assert "public" not in path, path
    assert "limit=5" in path, path
