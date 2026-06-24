#!/usr/bin/env python3
"""Firmware app-factory quick start: build, validate, snapshot.

Fork a fresh sandbox, cross-compile firmware for a Cortex-M MCU at an exact
commit, run a smoke test under QEMU in TCG mode (foreign arch, no hardware,
no nested virt, no GPU), then snapshot the exact VM that passed the gate as
the release artifact. The release IS the validated state: restorable byte for
byte and traceable to the commit, not a rebuild from HEAD.

Run:
    pip install arker
    ARKER_API_KEY=ark_live_...  ARKER_REGION=us-west-2  python quick-start-firmware-app-factory.py
"""
import time
from arker import Arker

ar = Arker()  # reads ARKER_API_KEY and ARKER_REGION (or pass region="us-west-2")


def sh(command, timeout=600):
    """Run a command and wait for it to finish. The SDK returns a background
    handle for long-running commands (e.g. apt install), so poll until done."""
    r = vm.run(command, timeout=timeout)
    while r.state == "running":
        time.sleep(2)
        r = vm.get_run(r.run_id)
    return r

# A self-contained firmware project so the example runs as-is. In practice this
# is your firmware repo, already cloned into the golden; skip straight to the
# fetch/checkout below.
SETUP_SRC = r"""
set -e
mkdir -p /src && cd /src
cat > firmware.c <<'EOF'
#include <stdint.h>
static void w0(const char *s){register int r0 asm("r0")=0x04;register const char *r1 asm("r1")=s;
  asm volatile("bkpt 0xAB"::"r"(r0),"r"(r1):"memory");}
static void halt(void){register int r0 asm("r0")=0x18;register int r1 asm("r1")=0x20026;
  asm volatile("bkpt 0xAB"::"r"(r0),"r"(r1):"memory");}
int main(void){ w0("SMOKE_OK\n"); halt(); return 0; }
void Reset_Handler(void){ main(); for(;;){} }
__attribute__((section(".vectors"),used)) static void(*const v[])(void)={
  (void(*)(void))0x20010000, Reset_Handler };
EOF
cat > link.ld <<'EOF'
ENTRY(Reset_Handler)
MEMORY {
  FLASH (rx)  : ORIGIN = 0x00000000, LENGTH = 256K
  RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = 64K
}
SECTIONS {
  .text : { KEEP(*(.vectors)) *(.text*) *(.rodata*) } > FLASH
  .data : { *(.data*) } > RAM AT > FLASH
  .bss  : { *(.bss*)  } > RAM
}
EOF
git init -q && git add .
git -c user.email=ci@arker.ai -c user.name=ci commit -q -m "firmware v1"
"""

# 1. Fork a fresh sandbox; install the cross-toolchain + emulator.
vm = ar.fork("ubuntu-full", name="firmware-build")
sh("export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && "
       "apt-get install -y -qq gcc-arm-none-eabi qemu-system-arm", timeout=600)
sh(SETUP_SRC, timeout=120)

# Pin to an exact commit (a coding agent or CI would supply this).
COMMIT = sh("git -C /src rev-parse --short HEAD").stdout.decode().strip()

# 2. Cross-compile the firmware for the target MCU at that commit.
sh(f"git -C /src checkout -q {COMMIT}")
b = sh("mkdir -p /build && arm-none-eabi-gcc -mcpu=cortex-m3 -mthumb "
           "-nostartfiles -nostdlib -ffreestanding -O2 -T /src/link.ld "
           "/src/firmware.c -o /build/fw.elf")
assert b.exit_code == 0, b.stderr.decode()

# 3. Validation gate: run the smoke test under QEMU in TCG mode (foreign arch,
#    no hardware, no nested virt, no GPU). QEMU semihosting writes to stderr,
#    so fold both streams together when checking the result.
t = sh("qemu-system-arm -M lm3s6965evb -cpu cortex-m3 -nographic "
       "-semihosting -kernel /build/fw.elf")
log = (t.stdout + t.stderr).decode()
passed = t.exit_code == 0 and "SMOKE_OK" in log
print("smoke test:", "SMOKE_OK" if passed else "FAILED")

# 4. The release IS the validated state: snapshot the exact VM that passed.
#    Restorable byte for byte, traceable to the commit, not a rebuild from HEAD.
if passed:
    artifact = ar.fork(vm, name=f"release-{COMMIT}")
    print("validated artifact:", artifact.id)
else:
    raise SystemExit("smoke test failed; not releasing")
