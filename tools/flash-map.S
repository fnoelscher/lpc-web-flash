.syntax unified
.cpu cortex-m3
.thumb
.section .text
.global flash_map
.thumb_func
flash_map:
    ldr r0, =0x400fc040
    movs r1, #1
    str r1, [r0]
    dsb sy
    isb sy
    // ROM R accepts flash/RAM only. Report the observed register value in RAM.
    ldr r1, [r0]
    ldr r2, =0x10000240
    str r1, [r2]
    bx lr
    .balign 4
    .ltorg
    // Uploaded with the helper: clear any stale result before execution.
    .org 64
    .word 0
