"""Per-game compatibility data, shared by the emulator (game.py), the browser build
(tools/prepare_web.py) and the open-source package's setup script. Standard library only.
"""
import struct

# Known games: uid -> (title, status). Status "ok" = plays; anything else is shown to the player.
TITLES = {
    0x2000AFBC: ('Hooked On: Creatures of the Deep', 'ok'),
    0x2000AFE5: ('Block Breaker Deluxe', 'ok'),
    0x2000B4B3: ('Brain Challenge', 'stops at the N-Gage splash'),
}


def crc32_forge(data, target):
    """data + 4 bytes whose zlib.crc32 equals target."""
    import zlib
    tbl = []
    for i in range(256):
        c = i
        for _ in range(8):
            c = (c >> 1) ^ 0xEDB88320 if c & 1 else c >> 1
        tbl.append(c)
    top = {t >> 24: i for i, t in enumerate(tbl)}
    reg, idx = target ^ 0xFFFFFFFF, []
    for _ in range(4):                                  # walk the register back four bytes
        i = top[reg >> 24]
        idx.append(i)
        reg = ((reg ^ tbl[i]) << 8) & 0xFFFFFFFF
    st, tail = zlib.crc32(data) ^ 0xFFFFFFFF, bytearray()
    for i in reversed(idx):
        tail.append((st ^ i) & 0xFF)
        st = (st >> 8) ^ tbl[i]
    return data + bytes(tail)


def empty_reslib(entries, crc):
    """An Infinite Dreams resource library (int16 count, int32 offsets) whose entries are all empty."""
    return crc32_forge(struct.pack('<h', entries) + bytes(4 * entries), crc)


# Files a game cannot run without that only exist as OMA DRM (DCF) content in the packages we
# have: the phone decrypted them with a rights object from the Nokia store, which is gone.
# Each is replaced by a harmless stand-in.  uid -> lower-case file name -> builder.
STANDINS = {
    0x2000AFE5: {'sound.lib.ngdat': lambda: empty_reslib(14, 0xBF3242B4)},   # Block Breaker: 13 silent sounds
}


# Decrypted data files in the packages that don't match the checksum the game verifies (the
# cracked package's decrypter produced slightly different files). The content is fine: 4 bytes
# appended after the data make the CRC-32 match. uid -> lower-case file name -> patcher(bytes).
PATCHES = {
    0x2000B4B3: {'brain_fullgame.lib.ngdat': lambda d: crc32_forge(d, 0x3CEAB217)},   # Brain Challenge
}


# Games drawn in portrait (240x320) rather than the landscape 320x240 most N-Gage games use.
PORTRAIT = {0x2000B4B3}                         # Brain Challenge


def title_of(uid, fallback):
    """(title, status) for the game picker."""
    return TITLES.get(uid, (fallback, 'untested'))


def copy_private(src, dst, uid):
    """Copy a game's private folder (subfolders kept), applying STANDINS and PATCHES.
    Returns (relative file list, notes about replaced files)."""
    import os
    import shutil
    standins, patches = STANDINS.get(uid, {}), PATCHES.get(uid, {})
    files, notes = [], []
    for d, _, names in os.walk(src):
        for fn in sorted(names):
            rel = os.path.relpath(os.path.join(d, fn), src).replace(os.sep, '/')
            out = os.path.join(dst, rel)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            top = '/' not in rel
            with open(os.path.join(d, fn), 'rb') as f:
                raw = f.read()
            encrypted = raw[4:12] == b'ftypodcf'
            build = standins.get(fn.lower()) if top else None
            patch = patches.get(fn.lower()) if top else None
            if build and encrypted:
                data = build()
                notes.append(f'{rel}: DRM-encrypted, replaced by a stand-in')
            elif patch and not encrypted:
                data = patch(raw)
                notes.append(f'{rel}: checksum patched')
            else:
                data = raw
            with open(out, 'wb') as f:
                f.write(data)
            files.append(rel)
    return sorted(files), notes
