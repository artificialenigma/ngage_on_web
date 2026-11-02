@ Native ARM replacements for hot runtime helpers (division, memcpy/memset family).
@ Running these inside the emulated CPU avoids a host round trip per call.
@ Build: python3 -I build_guestlib.py   (assembles with clang -target armv6-none-eabi)

        .syntax unified
        .arm
        .text

@ ---------------------------------------------------------------- division
@ r0 = n, r1 = d  ->  r0 = n / d, r1 = n % d   (d == 0 -> q = 0, r = n)
        .global __aeabi_uidivmod
__aeabi_uidivmod:
.Luidivmod:
        cmp     r1, #0
        beq     1f
        cmp     r1, r0
        bhi     1f
        mov     r2, r0
        mov     r0, #0
        clz     r12, r1
        clz     r3, r2
        sub     r12, r12, r3
        mov     r3, #1
        lsl     r1, r1, r12
        lsl     r3, r3, r12
2:      cmp     r2, r1
        subhs   r2, r2, r1
        orrhs   r0, r0, r3
        lsr     r1, r1, #1
        lsrs    r3, r3, #1
        bne     2b
        mov     r1, r2
        bx      lr
1:      mov     r1, r0
        mov     r0, #0
        bx      lr

@ r0 = n, r1 = d (signed)  ->  r0 = quotient (truncated), r1 = remainder (sign of n)
        .global __aeabi_idivmod
__aeabi_idivmod:
        push    {r4, r5, lr}
        mov     r4, r0
        eor     r5, r0, r1
        cmp     r0, #0
        rsblt   r0, r0, #0
        cmp     r1, #0
        rsblt   r1, r1, #0
        mov     lr, pc              @ lr = address after the b (clang leaves bl relocated)
        b       .Luidivmod
        cmp     r5, #0
        rsblt   r0, r0, #0
        cmp     r4, #0
        rsblt   r1, r1, #0
        pop     {r4, r5, pc}

@ ---------------------------------------------------------------- memcpy / memmove
@ r0 = dst, r1 = src, r2 = n
        .global __aeabi_memmove
        .global __aeabi_memmove4
__aeabi_memmove:
__aeabi_memmove4:
        cmp     r0, r1
        bls     .Lmemcpy
        add     r3, r1, r2
        cmp     r0, r3
        bhs     .Lmemcpy
        add     r0, r0, r2
        add     r1, r1, r2
3:      subs    r2, r2, #1
        bxlo    lr
        ldrb    r3, [r1, #-1]!
        strb    r3, [r0, #-1]!
        b       3b

        .global __aeabi_memcpy
        .global __aeabi_memcpy4
__aeabi_memcpy:
__aeabi_memcpy4:
.Lmemcpy:
        orr     r3, r0, r1
        tst     r3, #3
        bne     5f
4:      cmp     r2, #16
        blo     6f
        push    {r4, r5}
7:      ldmia   r1!, {r3, r4, r5, r12}
        stmia   r0!, {r3, r4, r5, r12}
        sub     r2, r2, #16
        cmp     r2, #16
        bhs     7b
        pop     {r4, r5}
6:      cmp     r2, #4
        blo     5f
        ldr     r3, [r1], #4
        str     r3, [r0], #4
        sub     r2, r2, #4
        b       6b
5:      subs    r2, r2, #1
        bxlo    lr
        ldrb    r3, [r1], #1
        strb    r3, [r0], #1
        b       5b

@ ---------------------------------------------------------------- memset / memclr
@ __aeabi_memset(dst, n, c); __aeabi_memclr(dst, n)
        .global __aeabi_memclr
        .global __aeabi_memclr4
__aeabi_memclr:
__aeabi_memclr4:
        mov     r2, #0
        .global __aeabi_memset
__aeabi_memset:
        and     r2, r2, #0xff
        orr     r2, r2, r2, lsl #8
        orr     r2, r2, r2, lsl #16
8:      tst     r0, #3
        beq     9f
        subs    r1, r1, #1
        bxlo    lr
        strb    r2, [r0], #1
        b       8b
9:      cmp     r1, #4
        blo     10f
        str     r2, [r0], #4
        sub     r1, r1, #4
        b       9b
10:     subs    r1, r1, #1
        bxlo    lr
        strb    r2, [r0], #1
        b       10b

@ ---------------------------------------------------------------- C++ array helpers
@ These call back into game code, so they must run natively (a Python stub cannot
@ re-enter the emulator). Callbacks use blx, so ARM and Thumb targets both work.

@ void* __cxa_vec_ctor(void* p, size_t count, size_t size, ctor, dtor)
        .global __cxa_vec_ctor
__cxa_vec_ctor:
.Lvec_ctor:
        push    {r4, r5, r6, r7, r8, lr}
        mov     r4, r0                  @ p
        mov     r5, r1                  @ remaining
        mov     r6, r2                  @ size
        movs    r7, r3                  @ ctor
        mov     r8, r0                  @ cursor
        beq     12f
11:     subs    r5, r5, #1
        blo     12f
        mov     r0, r8
        blx     r7
        add     r8, r8, r6
        b       11b
12:     mov     r0, r4
        pop     {r4, r5, r6, r7, r8, pc}

@ void* __aeabi_vec_ctor_nocookie_nodtor(void* p, ctor, size_t size, size_t count)
        .global __aeabi_vec_ctor_nocookie_nodtor
__aeabi_vec_ctor_nocookie_nodtor:
        mov     r12, r1
        mov     r1, r3
        mov     r3, r12                 @ -> (p, count, size, ctor)
        b       .Lvec_ctor

@ void __cxa_vec_dtor(void* p, size_t count, size_t size, dtor) — destroys in reverse order
        .global __cxa_vec_dtor
__cxa_vec_dtor:
.Lvec_dtor:
        push    {r4, r5, r6, r7, r8, lr}
        movs    r7, r3
        beq     16f
        mov     r5, r1
        mov     r6, r2
        mul     r8, r1, r2
        add     r8, r0, r8              @ one past the end
15:     subs    r5, r5, #1
        blo     16f
        sub     r8, r8, r6
        mov     r0, r8
        blx     r7
        b       15b
16:     pop     {r4, r5, r6, r7, r8, pc}

@ void* __aeabi_vec_dtor_cookie(void* p, dtor) — cookie {size, count} sits 8 bytes before p
        .global __aeabi_vec_dtor_cookie
__aeabi_vec_dtor_cookie:
        cmp     r0, #0
        bxeq    lr
        push    {r4, lr}
        sub     r4, r0, #8
        mov     r3, r1
        ldr     r2, [r4]                @ size
        ldr     r1, [r4, #4]            @ count
        mov     lr, pc
        b       .Lvec_dtor
        mov     r0, r4
        pop     {r4, pc}

@ void* __cxa_vec_new2(count, size, padding, ctor, void* (*alloc)(size_t), dealloc)
        .global __cxa_vec_new2
__cxa_vec_new2:
        push    {r4, r5, r6, r7, r8, lr}
        mov     r4, r0                  @ count
        mov     r5, r1                  @ size
        mov     r6, r2                  @ padding
        mov     r7, r3                  @ ctor
        ldr     r12, [sp, #24]          @ alloc
        mla     r0, r4, r5, r6
        blx     r12
        cmp     r0, #0
        beq     18f
        add     r8, r0, r6              @ array start
        cmp     r6, #0
        beq     17f
        str     r4, [r8, #-4]           @ cookie: count
        cmp     r6, #8
        strhs   r5, [r8, #-8]           @           size
17:     mov     r0, r8
        mov     r1, r4
        mov     r2, r5
        mov     r3, r7
        mov     lr, pc
        b       .Lvec_ctor
        mov     r0, r8
18:     pop     {r4, r5, r6, r7, r8, pc}

@ void qsort(void* base, size_t n, size_t size, int (*cmp)(const void*, const void*))
@ Insertion sort by adjacent byte-swaps: stable and simple; the game sorts small arrays.
        .global qsort
qsort:
        push    {r4, r5, r6, r7, r8, r9, r10, r11, lr}
        mov     r4, r0                  @ base
        mov     r5, r1                  @ n
        mov     r6, r2                  @ size
        mov     r7, r3                  @ cmp
        mov     r8, #1                  @ i
20:     cmp     r8, r5
        bhs     25f
        mov     r9, r8                  @ j = i
21:     cmp     r9, #0
        beq     24f
        mul     r10, r9, r6
        add     r10, r4, r10            @ &a[j]
        sub     r11, r10, r6            @ &a[j-1]
        mov     r0, r11
        mov     r1, r10
        blx     r7
        cmp     r0, #0
        ble     24f                     @ a[j-1] <= a[j]: in place
        mov     r2, r6                  @ swap size bytes
22:     subs    r2, r2, #1
        blo     23f
        ldrb    r0, [r10, r2]
        ldrb    r1, [r11, r2]
        strb    r1, [r10, r2]
        strb    r0, [r11, r2]
        b       22b
23:     sub     r9, r9, #1
        b       21b
24:     add     r8, r8, #1
        b       20b
25:     pop     {r4, r5, r6, r7, r8, r9, r10, r11, pc}
