# Arker API Contract

`openapi.json` is the vendored public VM API contract used by the SDK. The SDK
generates its Python and TypeScript wire types from this file. Builds and tests
do not fetch a contract from another repository or from the network.

Synchronize from a contract that is already on the local filesystem:

```sh
./scripts/sync-openapi --source-file /path/to/openapi.json
```

This copies the contract to `contract/openapi.json` and regenerates both
language outputs. The command does not make network requests.

Verify the vendored contract and generated outputs without modifying the
checkout:

```sh
./scripts/check-openapi
```

Install the repository's pre-push hook once per checkout:

```sh
./scripts/install-hooks
```

The hook gives fast feedback by checking generated artifacts, verifying that SDK
wire types come from the generated files, and running the TypeScript typecheck.

Run every SDK check locally with:

```sh
./scripts/check-local
```

This installs the locked development dependencies, checks the contract and
generated types, and runs the complete Python and TypeScript test suites. The
repository does not use GitHub-hosted CI for these checks.

SDK behavior stays handwritten; generated files define wire models and
operation shapes. Runtime adoption of those shapes can happen independently of
contract synchronization.
