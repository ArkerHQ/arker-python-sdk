# Arker API Contract

`openapi.json` is the vendored public VM API contract used by the SDK. Its exact
source commit and SHA-256 digest are recorded in `source.json`.

Synchronize the contract from `ArkerHQ/arker-app`'s `main` branch and regenerate
the TypeScript and Python wire types with:

```sh
./scripts/sync-openapi
```

To synchronize from an already-downloaded contract instead, provide its exact
`arker-app` source commit:

```sh
./scripts/sync-openapi \
  --source-file /path/to/openapi.json \
  --source-commit <40-character-commit-sha>
```

Verify the source contract, metadata, and generated outputs without modifying
the checkout with:

```sh
./scripts/check-openapi
```

`sync-openapi` authenticates through the developer's existing `gh` credentials.
`check-openapi` is local-only: it regenerates from the vendored contract and fails
if the source metadata or either language's generated output has drifted. CI
runs this check on every pull request.

The separate `openapi-freshness` status compares the proposed SDK contract
byte-for-byte with `arker-app/main`. It runs for every pull request, every push
to SDK `main`, once a day, and on manual dispatch. Because `arker-app` is private,
the workflow uses `ARKER_APP_OPENAPI_READ_TOKEN`, a fine-grained token limited to
Contents: Read on that repository. The pull request workflow checks out tooling
from SDK `main`, downloads the proposed contract as data, and never executes pull
request code while that credential is available.

`openapi-freshness` is required by the SDK's `Protect-Main` ruleset. Authorized
maintainers can use that ruleset's existing bypass checkbox for an exceptional
merge. The failed status remains on the commit as the audit trail.

Synchronizing the vendored contract and opening its review remains an explicit
maintainer action; no GitHub App or cross-repository write credential is used.

SDK behavior stays handwritten; generated files define wire models and
operation shapes. Runtime adoption of those shapes can happen independently of
contract synchronization.
