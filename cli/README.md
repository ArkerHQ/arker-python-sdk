<div align="center">

<img src="../assets/banner.png" alt="Arker" width="480" />

[Docs](https://arker.ai/docs) / [Benchmarks](https://arker.ai/benchmarks) / [Console](https://arker.ai/console)

</div>

# Arker CLI

The Arker CLI provides command-line access to Arker VMs.

[![npm](https://img.shields.io/npm/v/@arker-ai/cli.svg?style=flat-square&label=npm)](https://www.npmjs.com/package/@arker-ai/cli)

## Install

```bash
bun add --global @arker-ai/cli
```

The CLI requires Node.js 18 or later.

## Get started

Sign up and get your API key at [arker.ai/console](https://arker.ai/console).

`ARKER_API_KEY` is required. Compute commands also require a provider and
region unless `ARKER_BASE_URL` is configured.

```bash
export ARKER_API_KEY=ark_live_...
```

You can override the default placement:

```bash
export ARKER_PROVIDER=aws
export ARKER_REGION=us-west-2
```

For persistent configuration, create `~/.arker/config.json`:

```json
{
  "apiKey": "ark_live_...",
  "provider": "aws",
  "region": "us-west-2"
}
```

List the public source VMs:

```bash
arker vms ls --source-org-id ArkerHQ --public
```

VM listings also accept `--platform`, `--created-after`, and
`--created-before`, in addition to the existing placement, state, and
pagination filters.

Fork a source VM:

```bash
arker fork <source-vm-name>
```

Fork sources are mutually exclusive. You can also fork by VM ID, from an OCI
image, or from a local Dockerfile and build context:

```bash
arker fork --source-vm-id <source-vm-id>
arker fork --source-vm-name <name> --source-org-name ArkerHQ
arker fork --image ubuntu:24.04
arker fork --dockerfile ./Dockerfile --context .
```

The fork command also supports registry credentials, SSH keys, durable
recovery, inherited layers, and an initial network policy:

```bash
arker fork --image ghcr.io/example/private:v1 \
  --registry-auth-file ./registry-auth.json \
  --ssh-public-key "$(cat ~/.ssh/id_ed25519.pub)" \
  --durable \
  --nestedvirt \
  --policies-file ./policies.json

arker fork <source-vm-name> --layers disk,memory
```

`--registry-auth-file` must contain a JSON object with string `username` and
`password` fields. `--policies-file` must contain a JSON object that matches
the API policy document. Repeat `--ssh-public-key` to add more keys, or use
`--ssh-public-keys-file` with one authorized-key entry per non-empty line.
`--layers` accepts `disk` or `disk,memory` for VM sources. `--context` requires
`--dockerfile`. `--nestedvirt` applies only to image and Dockerfile forks.
Use `--disk` or `--no-disk` to select disk-backed or memory-backed storage
explicitly.

Use the returned VM ID to run commands, sync files, or open a terminal:

```bash
arker run <vm-id> python3 -c 'print(2 + 2)'

arker sync <vm-id> /tmp/hello.txt "hello from Arker"
arker sync <vm-id> /tmp/hello.txt --read

arker shell <vm-id>
```

Run options include resource overrides (`--vcpu`, `--memory-mib`, and
`--disk-mib`), `--memory-backend`, `--end-symbol`, `--policies-file`, and
`--idempotency-key`.

Create a configured session before running commands in it:

```bash
arker sessions create <vm-id> \
  --env-file ./env.json \
  --env MODE=development \
  --cwd /workspace \
  --pty --cols 120 --rows 40 \
  --command /bin/bash
```

Update a VM's resources, SSH keys, or policy:

```bash
arker update <vm-id> --vgpu 0.25
arker update <vm-id> --ssh-public-keys-file ./authorized_keys
arker update <vm-id> --policies-file ./policies.json
```

List runs on one VM, with optional RFC 3339 time filters:

```bash
arker runs ls <vm-id> --started-after 2026-01-01T00:00:00Z
```

Omit the VM ID to list activity across the organization. This call uses the
control plane, so it does not require a compute placement:

```bash
arker runs ls \
  --since 1767225600 \
  --until 1767312000 \
  --vms vm_123,vm_456 \
  --endpoint run \
  --status success \
  --limit 100 \
  --json
```

Organization-wide run listings also support `--vm`, `--region`, `--provider`,
`--search`, `--offset`, `--lite`, `--runtime`, `--actions`, `--status-min`,
`--status-max`, `--sort`, and `--dir`. Limits above 200 require `--lite`; the
maximum with `--lite` is 20,000.

Delete the VM when you are finished:

```bash
arker rm <vm-id>
```

Run `arker --help` for the available commands and flags.

## Documentation and examples

Read the [Arker documentation](https://arker.ai/docs) and browse the runnable [examples](../examples).

## License

Apache-2.0
