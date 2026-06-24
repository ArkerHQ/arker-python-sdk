#!/usr/bin/env python3
"""Firmware app-factory quick start: coding agent, cross-compile, simulate.

A background firmware-coding agent on Arker: fork a sandbox, let the Cursor CLI
agent WRITE the firmware, CROSS-COMPILE it for a Cortex-M MCU, and SIMULATE it
under QEMU in TCG mode (foreign arch, no hardware, no nested virt, no GPU).
Finally snapshot the exact VM that passed the gate as the release artifact, so
the release IS the validated state, not a rebuild from HEAD.

Swap Cursor for Codex or Claude Code by changing the install + agent call in
step 2; the rest is identical.

Run:
    pip install arker
    ARKER_API_KEY=ark_live_...  ARKER_REGION=us-west-2  CURSOR_API_KEY=...  python quick-start-firmware-app-factory.py
"""
import os
import shlex
import time
from arker import Arker

ar = Arker()  # reads ARKER_API_KEY and ARKER_REGION (or pass region="us-west-2")
CURSOR_API_KEY = os.environ["CURSOR_API_KEY"]  # https://cursor.com/dashboard


def sh(command, timeout=600):
    """Run a command and wait for it to finish. The SDK returns a background
    handle for long-running commands (e.g. apt install), so poll until done."""
    r = vm.run(command, timeout=timeout)
    while r.state == "running":
        time.sleep(2)
        r = vm.get_run(r.run_id)
    return r


# The task for the agent. In practice this comes from your issue tracker or CI;
# the expected marker (SMOKE_OK) is the test the firmware must satisfy.
PROMPT = (
    "Write a minimal Cortex-M3 bare-metal firmware for QEMU machine lm3s6965evb. "
    "Files: fw.c and a linker script fw.ld in the current directory. Vector table "
    "in section .vectors with [0]=initial SP 0x20010000 and [1]=Reset_Handler; "
    "flash at 0x0, 64K SRAM at 0x20000000. main() must print exactly SMOKE_OK via "
    "ARM semihosting (SYS_WRITE0, bkpt 0xAB) then exit via SYS_EXIT. It must build "
    "with: arm-none-eabi-gcc -mcpu=cortex-m3 -mthumb -nostartfiles -nostdlib "
    "-ffreestanding -O2 -T fw.ld fw.c -o fw.elf . Iterate until fw.elf builds."
)

# 1. Fork a sandbox; install the Cursor CLI + the embedded toolchain.
vm = ar.fork("ubuntu-full", name="firmware-agent")
sh("curl https://cursor.com/install -fsS | bash", timeout=300)
sh("export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && "
   "apt-get install -y -qq gcc-arm-none-eabi qemu-system-arm", timeout=600)

# 2. Run the coding agent: it writes the firmware (-f trusts the dir non-interactively).
sh(f"mkdir -p /work && cd /work && CURSOR_API_KEY={CURSOR_API_KEY} "
   f"cursor-agent -f -p {shlex.quote(PROMPT)}", timeout=600)

# 3. Cross-compile the agent's firmware for the target MCU.
b = sh("cd /work && arm-none-eabi-gcc -mcpu=cortex-m3 -mthumb -nostartfiles "
       "-nostdlib -ffreestanding -O2 -T fw.ld fw.c -o fw.elf")
assert b.exit_code == 0, b.stderr.decode()

# 4. Validation gate: simulate under QEMU in TCG mode (foreign arch, no hardware,
#    no nested virt, no GPU). QEMU semihosting writes to stderr, so fold streams.
t = sh("cd /work && qemu-system-arm -M lm3s6965evb -cpu cortex-m3 -nographic "
       "-semihosting -kernel fw.elf")
log = (t.stdout + t.stderr).decode()
# The smoke marker is the contract. A bare-metal image's QEMU exit code depends
# on how the firmware calls SYS_EXIT, so gate on the emitted output, not on it.
passed = "SMOKE_OK" in log
print("smoke test:", "SMOKE_OK" if passed else "FAILED")

# 5. The release IS the validated state: snapshot the exact VM that passed.
if passed:
    artifact = ar.fork(vm, name="firmware-release")
    print("validated artifact:", artifact.id)
else:
    raise SystemExit("smoke test failed; not releasing")
