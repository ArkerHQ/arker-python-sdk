# Arker API Contract

`openapi.json` is the vendored public VM API contract used by the SDK. Its exact
source commit and SHA-256 digest are recorded in `source.json`.

Synchronize the contract from `ArkerHQ/arker-app`'s `main` branch and regenerate
the TypeScript and Python wire types with:

```sh
./scripts/sync-openapi
```

Verify the source contract, metadata, and generated outputs without modifying
the checkout with:

```sh
./scripts/check-openapi
```

Local commands authenticate through the developer's existing `gh` credentials.
CI uses a short-lived, contents-read GitHub App installation token. The
privileged workflow runs code only from the trusted base branch and treats pull
request files as untrusted data. Configure the App ID as the repository variable
`ARKER_CONTRACT_APP_ID` and its private key as the repository secret
`ARKER_CONTRACT_APP_PRIVATE_KEY`; install the App on `arker-app` with only
Contents: Read permission.

SDK behavior stays handwritten; generated files define wire models and
operation shapes. Runtime adoption of those shapes can happen independently of
contract synchronization.
