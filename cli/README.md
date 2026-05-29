# arker CLI

## Install

```sh
npm install -g @arker-ai/cli
```

## Configure

```sh
export ARKER_API_KEY=ark_…
export ARKER_REGION=us-west-2
export ARKER_PROVIDER=aws            # optional; default aws (use `aws-burst` for Arkuntu)
# export ARKER_CONTROL_BASE_URL=https://arker.ai/api   # optional override
```

Or `~/.arker/config.json`:

```json
{
  "apiKey": "ark_…",
  "region": "us-west-2",
  "provider": "aws"
}
```

The legacy combined form `region=aws-us-west-2` is still accepted and
auto-splits into `provider=aws`, `region=us-west-2`.

## Use

```sh
# Shortcuts
arker ls                                                  # list VMs
arker rm vm_abc                                           # delete a VM
arker fork arkuntu                                        # public VM in ArkerHQ
arker fork --source-vm-id vm_abc                          # fork by global id
arker fork --source-vm-name base --source-org-id ArkerHQ  # fork by name in another org
arker run vm_abc "uname -a"                               # run a command
arker shell                                               # interactive shell (forks ubuntu-full)
arker shell vm_abc                                        # interactive shell on existing VM

# Resources
arker vms ls --provider aws --state idle
arker vms get vm_abc
arker runs ls vm_abc --state completed
arker runs get vm_abc run_xyz
arker sessions ls vm_abc
arker sessions create vm_abc --cwd /tmp
arker syncs create vm_abc --path /data --filesystem-name media --create
arker syncs ls vm_abc
arker syncs read vm_abc /data/file.txt
echo hello | arker syncs write vm_abc /data/hello.txt
arker tunnels ls vm_abc
arker tunnels rm vm_abc 8080
arker fs ls
arker fs rm fs_abc
```

`arker shell` forks `ubuntu-full` from `ArkerHQ`, prints the new VM
as a get-style JSON, then drops into a minimal `>` REPL:

```
$ arker shell
{
  "vm_id": "vm_01J…",
  "owner_org_id": "your_org",
  "public": false,
  "state": "idle",
  ...
}
> uname -a
Linux ubuntu 6.6.0-arkerd ...
> exit
```

Every list command takes `--cursor` and `--limit`. Append `--json` to
get structured output for scripting.

## Public VMs

Public VMs live in the `ArkerHQ` org. Today:

- **Ubuntu (`provider=aws`)**: `ubuntu`, `ubuntu-small`,
  `ubuntu-nodisk`, `ubuntu-nonet-nodisk`, `ubuntu-full`,
  `ubuntu-full-32`, `ubuntu-py-repl`, `ubuntu-js-repl`,
  `ubuntu-docker`, `ubuntu-chromium`, `ubuntu-servo`,
  `ubuntu-servo-py-repl`, `ubuntu-chromium-py-repl`.
- **Arkuntu (`provider=aws-burst`)**: `arkuntu`.

To list them:

```sh
arker ls --source-org-id ArkerHQ
```
