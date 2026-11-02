#!/usr/bin/env python3
"""Add your own installed N-Gage 2.0 games to the browser player.

Point it at a folder that holds installed games, for example EKA2L1's data folder after
installing the games there. It finds every game (an exe in Sys/Bin whose UID has a
Private/<uid> folder), copies what the player needs into games/<name>/ and lists the games
in games/index.json. Without an argument it looks in EKA2L1's default locations.

For each game it copies:
  Sys/Bin/<game>.exe and the game's own DLLs   (decompressed: the browser loader needs plain images)
  Private/<uid>/...                           the game's data (a few known DRM leftovers are fixed,
                                              see compat.py)

Usage:
  python3 tools/setup_game.py [path/to/folder]
"""
import json
import os
import re
import shutil
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, 'e32'))
sys.path.insert(0, HERE)
sys.path.insert(1, os.path.join(ROOT, 'proto'))        # in the source repository: port/proto/compat.py
sys.path.insert(2, os.path.join(ROOT, 'ref', 'ngi', 'tools'))   # ... and port/ref/ngi/tools/e32.py

import compat                                          # noqa: E402

GAMES = os.path.join(ROOT, 'games')
if not os.path.isdir(os.path.join(ROOT, 'js')):        # in the repository the player lives in web-emu/
    GAMES = os.path.join(ROOT, 'web-emu', 'games')
DEFAULT_ROOTS = [
    os.path.expanduser('~/Library/Application Support/EKA2L1'),      # macOS
    os.path.expanduser('~/.local/share/EKA2L1'),                      # Linux
    os.path.join(os.environ.get('APPDATA', ''), 'EKA2L1'),           # Windows (installed)
    os.path.join(os.environ.get('LOCALAPPDATA', ''), 'EKA2L1'),
]
# The phone's own libraries: the player provides these, so they are never copied.
PLATFORM_DLLS = {'euser', 'efsrv', 'libc', 'libm', 'libpthread', 'libdl', 'drtaeabi', 'drtrvct2_2',
                 'dfpaeabi', 'scppnwdl', 'runtime', 'ngiutil', 'arenaenv', 'ngifileaccess'}


def dll_base(name):
    return name.split('{')[0].split('[')[0].split('.')[0].lower()


def scan(root):
    """-> (binaries {lower name: path}, private dirs {uid: path})."""
    binaries, private = {}, {}
    for d, dirs, files in os.walk(root):
        low = d.replace('\\', '/').lower()
        if re.search(r'/drives/z(/|$)', low):            # EKA2L1's copy of the phone ROM: not games
            dirs[:] = []
            continue
        if low.endswith('/sys/bin'):
            for f in files:
                binaries.setdefault(f.lower(), os.path.join(d, f))
        m = re.search(r'/private/([0-9a-f]{8})$', low)
        if m and files:
            uid = int(m.group(1), 16)
            if uid not in private or len(files) > len(os.listdir(private[uid])):
                private[uid] = d
    return binaries, private


def plain_image(path):
    """E32 image with its code section inflated (the browser loader expects comp_type 0)."""
    raw = open(path, 'rb').read()
    if struct.unpack_from('<I', raw, 28)[0] == 0:
        return raw
    import e32
    img = bytearray(e32.load(path)['img'])
    struct.pack_into('<I', img, 28, 0)
    return bytes(img)


def imports_of(path):
    import e32
    try:
        return {dll_base(name) for name, _ in e32.load(path).get('imports', [])}
    except Exception:                                  # not a readable E32 image
        return set()


def game_dlls(exe, uid, binaries):
    """The game's own DLLs: its imports and its DRM file-manager factory, plus what those import."""
    todo = imports_of(exe) | {f'ngifilemanagerfactory_{uid:08x}'}
    found = set()
    while todo:
        base = todo.pop()
        if base in found or base in PLATFORM_DLLS or base + '.dll' not in binaries:
            continue
        found.add(base)
        todo |= imports_of(binaries[base + '.dll'])
    return sorted(found)


def add_game(exe_path, uid, private_dir, binaries):
    exe_name = os.path.basename(exe_path)
    title, status = compat.title_of(uid, exe_name[:-4])
    slug = re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')
    out = os.path.join(GAMES, slug)
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(os.path.join(out, 'sys'))
    sys_files = [exe_name] + [os.path.basename(binaries[b + '.dll']) for b in game_dlls(exe_path, uid, binaries)]
    for name in sys_files:
        with open(os.path.join(out, 'sys', name), 'wb') as f:
            f.write(plain_image(binaries[name.lower()]))
    files, notes = compat.copy_private(private_dir, os.path.join(out, 'private'), uid)
    with open(os.path.join(out, 'files.json'), 'w') as f:
        json.dump({'title': title, 'status': status, 'uid': uid, 'exe': exe_name,
                   'portrait': uid in compat.PORTRAIT, 'sys': sys_files, 'private': files}, f, indent=1)
    print(f'  {title}{"" if status == "ok" else f" ({status})"}: {len(files)} data files, {len(sys_files)} binaries')
    for note in notes:
        print('    ' + note)
    return {'slug': slug, 'title': title, 'status': status, 'uid': uid}


def main(argv):
    roots = [argv[1]] if len(argv) > 1 else [r for r in DEFAULT_ROOTS if r and os.path.isdir(r)]
    if not roots:
        sys.exit('No folder given and no EKA2L1 data folder found.\n'
                 'Usage: python3 tools/setup_game.py path/to/folder-with-installed-games')
    binaries, private = {}, {}
    for r in roots:
        print(f'searching {r} ...')
        b, p = scan(r)
        for k, v in b.items():
            binaries.setdefault(k, v)
        for k, v in p.items():
            private.setdefault(k, v)
    games = []
    for name, path in sorted(binaries.items()):
        if not name.endswith('.exe') or name.startswith('as_'):
            continue
        try:
            uid = struct.unpack_from('<I', open(path, 'rb').read(12), 8)[0]
        except struct.error:
            continue
        if uid in private and 'runtime' in imports_of(path):   # N-Gage 2.0 games use the NGI runtime
            games.append(add_game(path, uid, private[uid], binaries))
    if not games:
        sys.exit('No installed N-Gage games found. Install them (e.g. in EKA2L1) and point this script at that folder.')
    index_path = os.path.join(GAMES, 'index.json')
    index = json.load(open(index_path)) if os.path.exists(index_path) else []
    slugs = {g['slug'] for g in games}
    index = [g for g in index if g['slug'] not in slugs and os.path.isdir(os.path.join(GAMES, g['slug']))] + games
    with open(index_path, 'w') as f:
        json.dump(sorted(index, key=lambda g: g['title']), f, indent=1)
    print(f'{len(games)} game(s) ready in {GAMES}. Start the player with start.command / start.bat / start.sh.')


if __name__ == '__main__':
    main(sys.argv)
