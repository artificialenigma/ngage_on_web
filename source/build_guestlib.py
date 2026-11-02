#!/usr/bin/env python3
"""Assemble guestlib.s and emit guestlib.bin (raw .text) + guestlib.json ({symbol: offset})."""
import json
import os
import struct
import subprocess
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def text_and_symbols(obj):
    b = open(obj, 'rb').read()
    shoff, = struct.unpack_from('<I', b, 0x20)
    shentsize, shnum, shstrndx = struct.unpack_from('<HHH', b, 0x2e)
    secs = [struct.unpack_from('<10I', b, shoff + i * shentsize) for i in range(shnum)]
    shstr = secs[shstrndx]

    def sname(off, tab):
        start = tab[4] + off
        return b[start:b.index(b'\0', start)].decode()
    by_name = {sname(s[0], shstr): (i, s) for i, s in enumerate(secs)}
    ti, text = by_name['.text']
    code = b[text[4]:text[4] + text[5]]
    _, symtab = by_name['.symtab']
    strtab = secs[symtab[6]]
    syms = {}
    for k in range(symtab[5] // 16):
        name_off, value, size, info, other, shndx = struct.unpack_from('<IIIBBH', b, symtab[4] + 16 * k)
        if shndx == ti and (info >> 4) == 1:          # STB_GLOBAL in .text
            syms[sname(name_off, strtab)] = value
    return code, syms


def main():
    with tempfile.TemporaryDirectory() as td:
        obj = os.path.join(td, 'guestlib.o')
        subprocess.check_call(['clang', '-target', 'armv6-none-eabi', '-c',
                               os.path.join(HERE, 'guestlib.s'), '-o', obj])
        code, syms = text_and_symbols(obj)
    with open(os.path.join(HERE, 'guestlib.bin'), 'wb') as f:
        f.write(code)
    with open(os.path.join(HERE, 'guestlib.json'), 'w') as f:
        json.dump(syms, f, indent=1, sort_keys=True)
    print(f'guestlib: {len(code)} bytes, {len(syms)} symbols')


if __name__ == '__main__':
    main()
