#!/usr/bin/env bash
#
# Firmware app-factory quick start: a coding agent edits firmware, runs it on QEMU.
#
# Forks a sandbox, installs an embedded toolchain + emulator, seeds a known-good
# Cortex-M3 firmware, has the Cursor agent add a feature, and runs it under QEMU
# in TCG mode (headless: no hardware, no nested virt, no GPU).
#
# Prereqs: the Arker CLI (npm install -g @arker-ai/sdk) and jq.
#
#   ARKER_API_KEY=...  CURSOR_API_KEY=...  ./quick-start-firmware-app-factory.sh
set -uo pipefail
: "${ARKER_API_KEY:?set ARKER_API_KEY (https://arker.ai/console)}"
: "${CURSOR_API_KEY:?set CURSOR_API_KEY (https://cursor.com/dashboard)}"

GCC="arm-none-eabi-gcc -mcpu=cortex-m3 -mthumb -nostartfiles -nostdlib -ffreestanding -O2 -T fw.ld fw.c -o fw.elf"
QEMU="qemu-system-arm -M lm3s6965evb -cpu cortex-m3 -nographic -semihosting -kernel fw.elf"

# Baseline firmware. w0() prints a string over ARM semihosting (noinline so -O2
# can't clobber r0); main() just boots. The agent extends this.
FW_C='#include <stdint.h>
__attribute__((noinline)) static void w0(const char *s){
  register int op asm("r0")=0x04; register const char *p asm("r1")=s;
  asm volatile("bkpt 0xAB"::"r"(op),"r"(p):"memory"); }
static void halt(void){
  register int op asm("r0")=0x18; register int c asm("r1")=0x20026;
  asm volatile("bkpt 0xAB"::"r"(op),"r"(c):"memory"); }
int main(void){ w0("firmware: boot OK\n"); halt(); return 0; }
void Reset_Handler(void){ main(); for(;;){} }
__attribute__((section(".vectors"),used))
static void (*const v[])(void) = { (void(*)(void))0x20010000, Reset_Handler };'
FW_LD='ENTRY(Reset_Handler)
MEMORY {
  FLASH (rx)  : ORIGIN = 0x00000000, LENGTH = 256K
  RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = 64K
}
SECTIONS {
  .text : { KEEP(*(.vectors)) *(.text*) *(.rodata*) } > FLASH
  .data : { *(.data*) } > RAM AT > FLASH
  .bss  : { *(.bss*)  } > RAM
}'

b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
# Run a command in a VM and wait for it to finish (long ones go async, so poll).
run() {
  local r rid
  r=$(arker run "$1" "{ set +x; } 2>/dev/null; $2" 2>&1)
  rid=$(printf '%s' "$r" | jq -r '.run_id? // empty' 2>/dev/null || true)
  [ -n "${rid:-}" ] && until [ "$(arker runs get "$1" "$rid" 2>/dev/null | jq -r .state)" != running ]; do sleep 3; done
  return 0
}
show() { arker run "$1" "{ set +x; } 2>/dev/null; cat $2" 2>&1 | grep -vaE '^\+\+? ' || true; }

VM=$(arker fork ubuntu-full | jq -r .vm_id); echo "# forked $VM"

echo "# setup: install cross-toolchain + headless QEMU, seed baseline firmware"
run "$VM" "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends gcc-arm-none-eabi qemu-system-arm >/dev/null"
run "$VM" "mkdir -p /work && echo $(b64 "$FW_C") | base64 -d > /work/fw.c && echo $(b64 "$FW_LD") | base64 -d > /work/fw.ld && printf %s '$CURSOR_API_KEY' > /work/.key"

echo "# agent: add 'tick' x3 to the firmware"
run "$VM" "cd /work && CURSOR_API_KEY=\$(cat .key) cursor-agent -f -p 'Edit /work/fw.c so that after the boot line, main() prints tick three times using the existing w0() helper. Build with $GCC and run with $QEMU; iterate until it runs cleanly.' >/dev/null 2>&1"

echo "# firmware output:"
run "$VM" "cd /work && { $GCC && $QEMU; } > out.txt 2>&1"
show "$VM" /work/out.txt

echo "# done"
arker rm "$VM" >/dev/null 2>&1 || true
