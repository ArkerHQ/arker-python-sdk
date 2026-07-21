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
runs this check on every pull request. Synchronizing the vendored
contract with `arker-app/main` remains an explicit maintainer action.

SDK behavior stays handwritten; generated files define wire models and
operation shapes. Runtime adoption of those shapes can happen independently of
contract synchronization.
