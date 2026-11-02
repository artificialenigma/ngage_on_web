#!/usr/bin/env python3
"""Decompress Symbian E32 images (deflate & bytepair) - port of EKA2L1 loader logic."""
import struct, zlib, sys, os, glob

COMP_NONE = 0
COMP_DEFLATE = 0x101F7AFC
COMP_BYTEPAIR = 0x102822AA

def parse_e32_header(b):
    if len(b) < 124:
        raise ValueError("short")
    (uid1, uid2, uid3, check, sig) = struct.unpack_from('<5I', b, 0)
    if sig != 0x434F5045:  # EPOC
        raise ValueError("bad sig")
    (header_crc, majmin, comp_type, petran, msb, lsb,
     flags, code_size, data_size, heap_min, heap_max, stack, bss,
     entry, code_base, data_base, dll_ref, export_off, export_cnt,
     text_size, code_off, data_off, import_off, creloc, dreloc,
     priocpu) = struct.unpack_from('<27I', b, 20)
    hdr = dict(uid1=uid1, uid2=uid2, uid3=uid3, check=check, comp_type=comp_type,
               flags=flags, code_size=code_size, data_size=data_size,
               code_off=code_off, data_off=data_off, import_off=import_off,
               text_size=text_size, stack=stack, heap_min=heap_min, heap_max=heap_max,
               entry=entry, code_base=code_base)
    ver = 'eka1' if majmin in (0x2000, 0x1000) else 'eka2'
    if ver == 'eka2':
        hdr['major'], hdr['minor'] = majmin & 0xFFFF, majmin >> 16
        # wait: majmin is u16 pair; handled below
    return hdr, ver

def parse_header_exact(b):
    (uid1, uid2, uid3, check, sig) = struct.unpack_from('<5I', b, 0)
    sig = sig  # EPOC
    fixed = struct.unpack_from('<27I', b, 20)
    keys = 'header_crc majmin comp_type petran msb lsb flags code_size data_size heap_min heap_max stack bss entry code_base data_base dll_ref export_off export_cnt text_size code_off data_off import_off creloc dreloc priocpu'.split()
    h = dict(zip(keys, fixed))
    return (uid1, uid2, uid3, check, sig), h

def eka1_or_eka2(b):
    return b''

def bytepair_decompress(data, dest_size, buf_off=0):
    """Port of eka2l1 bytepair_decompress (whole buffer)."""
    i = 0; n = len(data)
    def rd():
        nonlocal i
        if i >= n: raise IndexError
        v = data[i]; i += 1
        return v
    total = rd()
    first = list(range(256)); second = list(range(256))
    marker = -1
    if total:
        marker = rd()
        first[marker] = (~marker) & 0xFF
        if total < 32:
            for _ in range(total):
                b_ = rd(); p1 = rd(); p2 = rd()
                first[b_] = p1; second[b_] = p2
        else:
            j = i; rc = 0
            for b_ in range(256):
                mask = data[j + (b_ >> 3)]
                if mask & (1 << (b_ & 7)):
                    p1 = data[j + 32 + 2*rc]; p2 = data[j + 32 + 2*rc + 1]
                    first[b_] = p1; second[b_] = p2
                    rc += 1
            i = j + 32 + 2*rc
            if rc != total: raise ValueError('pair count mismatch')
    out = bytearray()
    b_ = rd(); p1 = first[b_]; st = []
    ops = 0
    while True:
        ops += 1
        if ops > 2_000_000: raise ValueError('runaway')
        guard = 0
        while p1 != b_:
            guard += 1
            if guard > 4096: raise ValueError('chain loop')
            if b_ == marker:
                p1 = rd()
                break
            st.append(second[b_])
            b_ = p1
            p1 = first[b_]
            if b_ == p1:
                if st:
                    b_ = st.pop()
                    out.append(p1)
                    p1 = first[b_]
                else:
                    break
        if len(out) >= dest_size:
            return bytes(out[:dest_size])
        if i >= n:
            out.append(p1)
            return bytes(out[:dest_size])
        nb = rd()
        out.append(p1)
        b_ = nb
        p1 = first[b_]

def decompress_bytepair(raw_from_codeoff, dest_total):
    """ibytepair_stream::read_pages."""
    b = raw_from_codeoff
    i = 0
    unc_size, npages = struct.unpack_from('<IH', b, 0)
    i = 10
    for _ in range(npages):
        pass
    sizes = struct.unpack_from('<%dH' % npages, b, i)
    i += 2 * npages
    out = bytearray()
    for sz in sizes:
        page = bytepair_decompress(b[i:i+sz], min(4096, dest_total - len(out)))
        out += page
        i += sz
        if len(out) >= dest_total: break
    return bytes(out), npages, sizes

def decompress_image(b):
    (uid1, uid2, uid3, check, sig), h = parse_header_exact(b)
    header_flags = h['flags']
    header_format = (header_flags >> 24) & 0xF
    p = 20 + 27*4  # = 128
    hdr_extra = b''
    unc_size = None
    if header_format > 0:
        unc_size = struct.unpack_from('<I', b, p)[0]
        p += 4
        if header_format == 2:
            hdr_extra = b[p:p+28]
    ctype = h['comp_type']
    hdr_bytes = b[:h['code_off']]
    if ctype == COMP_NONE:
        return h, b
    payload = b[h['code_off']:]
    if ctype == COMP_DEFLATE:
        if unc_size is None:
            return h, b
        out = zlib.decompress(payload)  # hopefully ends cleanly
        if len(out) < unc_size:
            return h, None
        out = out[:unc_size]
        return h, hdr_bytes + out
    elif ctype == COMP_BYTEPAIR:
        if unc_size is None:
            unc_size = h['code_size'] + h['data_size']
        try:
            out, npages, sizes = decompress_bytepair(payload, unc_size)
            return h, hdr_bytes + out
        except Exception as e:
            return h, None
    return h, None
