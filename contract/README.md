# Arker API Contract

`openapi.json` is the vendored public VM API contract used by the SDK.

For now this file is copied into this repository as a versioned artifact. The
contract version is `info.version` inside the OpenAPI document. Regenerate the
TypeScript SDK types after updating it:

```sh
cd typescript
bun run generate:api-types
```

The SDK client code should stay handwritten; generated files should only define
request and response shapes.
