# arker CLI

Command-line interface for the Arker VM API. Wraps `@arker-ai/sdk`.

## Install

```sh
npm install -g @arker-ai/cli
```

## Configure

```sh
export ARKER_API_KEY=ark_…
export ARKER_REGION=aws-us-west-2
```

Or `~/.arker/config.json`:

```json
{
  "apiKey": "ark_…",
  "region": "aws-us-west-2"
}
```

## Use

```sh
# Shortcuts
arker ls                          # list VMs
arker rm vm_abc                   # delete a VM
arker fork arkuntu                # fork the public golden (shortcut for vm_name in Arker org)
arker fork --source-vm-id vm_abc           # fork by global id
arker fork --source-vm-name base --source-org-id <org>  # fork by name in another org
arker run vm_abc "uname -a"       # run a command
arker shell                       # interactive shell on a fresh fork
arker shell vm_abc                # interactive shell on an existing VM

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

Every list command takes `--cursor` and `--limit`. Append `--json` to get
structured output for scripting.
