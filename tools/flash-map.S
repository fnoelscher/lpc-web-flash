.syntax unified
.cpu cortex-m3
.thumb
.section .text
.global flash_map
.thumb_func
flash_map:
    ldr r0, =0x400fc040
    ldr r1, [r0]
    orr r1, r1, #1
    str r1, [r0]
    dsb sy
    isb sy
    bx lr
    .balign 4
    .ltorg
