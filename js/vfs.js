// In-memory file system with the prototype's path rules (port/proto/hle_libc.py host_path):
// the game's private dir maps to the shipped files, writes go to an overlay, and \sys + \resource
// are read-only (the DRM probes \sys\bin\pncrtest.txt and must be refused).

export class VFS {
  constructor(privateFiles, uidHex, onWrite) {
    this.private = `c:\\private\\${uidHex}\\`;
    this.prefixes = ['c:', 'e:', ''].map((d) => `${d}\\private\\${uidHex}\\`);
    this.base = new Map();                 // lower-case private name -> Uint8Array (read-only originals)
    for (const [name, data] of Object.entries(privateFiles)) this.base.set(name.toLowerCase(), data);
    this.overlay = new Map();              // normalised key -> Uint8Array (written files)
    this.onWrite = onWrite || null;        // persistence hook (browser: IndexedDB)
  }

  /** Normalise a Symbian path to a key: 'private/<name>' or 'other/<path>'. */
  key(guest) {
    let p = guest.replace(/\//g, '\\');
    if (!p.includes(':') && !p.startsWith('\\')) p = this.private + p;
    const low = p.toLowerCase();
    for (const pre of this.prefixes) {
      if (low.startsWith(pre)) return 'private/' + low.slice(pre.length).replace(/\\/g, '/');
    }
    return 'other/' + low.replace(':', '').replace(/\\/g, '/').replace(/^\/+/, '');
  }

  isSystemPath(guest) {
    const tail = guest.replace(/\//g, '\\').toLowerCase().replace(/^\\+/, '');
    const afterDrive = tail.includes(':') ? tail.split(':', 2)[1].replace(/^\\+/, '') : tail;
    return afterDrive.startsWith('sys\\') || afterDrive.startsWith('resource\\');
  }

  get(guest) {
    const k = this.key(guest);
    if (this.overlay.has(k)) return this.overlay.get(k);
    if (k.startsWith('private/')) return this.base.get(k.slice(8)) || null;
    return null;
  }

  exists(guest) { return this.get(guest) !== null; }

  put(guest, data) {
    const k = this.key(guest);
    this.overlay.set(k, data);
    if (this.onWrite) this.onWrite(k, data);
  }

  remove(guest) {
    const k = this.key(guest);
    this.overlay.delete(k);
    if (this.onWrite) this.onWrite(k, null);
  }

  listDir(guest) {
    const k = this.key(guest.replace(/[\\/]+$/, '') + '\\x').slice(0, -1);
    const out = new Set();
    if (k.startsWith('private/')) {
      for (const n of this.base.keys()) if (('private/' + n).startsWith(k)) out.add(n.slice(k.length - 8).split('/')[0]);
    }
    for (const n of this.overlay.keys()) if (n.startsWith(k)) out.add(n.slice(k.length).split('/')[0]);
    return [...out].sort();
  }
}

/** An open file: a byte buffer plus a position; writable files flush back into the VFS. */
export class OpenFile {
  constructor(vfs, guest, data, writable) {
    this.vfs = vfs;
    this.guest = guest;
    this.data = data;
    this.size = data.length;
    this.pos = 0;
    this.writable = writable;
  }

  read(n) {
    const out = this.data.slice(this.pos, Math.min(this.size, this.pos + n));
    this.pos += out.length;
    return out;
  }

  write(bytes) {
    const end = this.pos + bytes.length;
    if (end > this.data.length) {
      const grown = new Uint8Array(Math.max(end, this.data.length * 2));
      grown.set(this.data.subarray(0, this.size));
      this.data = grown;
    }
    this.data.set(bytes, this.pos);
    this.pos = end;
    this.size = Math.max(this.size, end);
  }

  seek(off, whence) {                      // whence: 0 start, 1 current, 2 end
    const base = whence === 1 ? this.pos : whence === 2 ? this.size : 0;
    this.pos = Math.max(0, base + off);
    return this.pos;
  }

  close() {
    if (this.writable) this.vfs.put(this.guest, this.data.slice(0, this.size));
  }
}
