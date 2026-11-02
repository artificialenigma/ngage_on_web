// Symbian euser / efsrv stubs used by the game's DRM file-manager DLL. Mirrors hle_euser.py.
// Descriptor word 0 = (type << 28) | length; types 0 BufC, 1 PtrC, 2 Ptr, 3 Buf, 4 BufCPtr.

import { OpenFile } from './vfs.js';

const M32 = 0xFFFFFFFF;
const KErrNone = 0, KErrNotFound = M32, KErrGeneral = (-2) >>> 0;
const CURRENT_PROCESS = 0xFFFF8000;

export function registerEuser(h) {
  const core = h.core, a = (i) => h.a(i), game = h.opts.game;
  const on = (dll, o, fn) => h.on(dll, o, fn);
  const EXE_PATH = 'E:\\sys\\bin\\' + game.exe;
  const st = { tls: new Map(), chunks: new Map(), globalChunks: new Map(), nextHandle: 0x1000, files: new Map(),
    parses: new Map(), libs: new Map(), allocator: null };
  const newHandle = () => (st.nextHandle += 4);

  // --- descriptors
  const header = (d) => { const w = h.r32(d); return [w >>> 28, w & 0x0FFFFFFF]; };
  const ptr = (d) => {
    const [t] = header(d);
    if (t === 0) return d + 4;
    if (t === 1) return h.r32(d + 4);
    if (t === 2) return h.r32(d + 8);
    if (t === 3) return d + 8;
    return h.r32(d + 8) + 4;
  };
  const maxlen = (d) => { const [t, ln] = header(d); return t >= 2 ? h.r32(d + 4) : ln; };
  const read = (d, wide) => { const [, ln] = header(d); return ln ? core.read(ptr(d), ln * (wide ? 2 : 1)) : new Uint8Array(0); };
  const text = (d, wide = true) => {
    const b = read(d, wide);
    let s = '';
    if (wide) for (let i = 0; i < b.length; i += 2) s += String.fromCharCode(b[i] | (b[i + 1] << 8));
    else s = String.fromCharCode(...b);
    return s;
  };
  const setLen = (d, n) => {
    const [t] = header(d);
    h.w32(d, ((t << 28) | n) >>> 0);
    if (t === 4) { const buf = h.r32(d + 8); h.w32(buf, ((h.r32(buf) & 0xF0000000) | n) >>> 0); }
  };
  const write = (d, data, wide, append = false) => {
    const unit = wide ? 2 : 1;
    const [, ln] = header(d);
    const start = append ? ln : 0;
    let n = data.length / unit;
    const mx = maxlen(d);
    if (start + n > mx) { n = Math.max(0, mx - start); data = data.slice(0, n * unit); }
    core.write(ptr(d) + start * unit, data);
    setLen(d, start + n);
  };
  const wideBytes = (s) => { const b = new Uint8Array(2 * s.length); for (let i = 0; i < s.length; i++) { b[2 * i] = s.charCodeAt(i) & 0xFF; b[2 * i + 1] = s.charCodeAt(i) >> 8; } return b; };
  const makePtrC = (out, addr, ln) => { h.w32(out, ((1 << 28) | ln) >>> 0); h.w32(out + 4, addr); };
  h.des = { header, ptr, maxlen, read, text, write, makePtrC };

  const wstrlen = (p) => h.wstr(p, 1 << 20).length;
  const strlen8 = (p) => h.cstrBytes(p).length;

  // --- process startup and exits (hle.py _register)
  on('euser', 1360, () => 0);                        // UserHeap::SetupThreadHeap -> KErrNone
  on('euser', 585, () => 0);                         // User::InitProcess
  on('euser', 196, () => h.heap.alloc(16));          // CTrapCleanup::New
  on('euser', 2060, () => 0);                        // User::MarkCleanupStack
  on('euser', 2061, () => 0);                        // User::UnMarkCleanupStack
  on('euser', 641, () => h.exit(a(0) | 0));          // User::Exit
  on('euser', 669, () => h.fail('User::Invariant'));
  on('euser', 613, () => h.fail('User::HandleException'));
  on('euser', 650, () => h.fail(`User::Panic(${text(a(0))}, ${a(1) | 0})`));
  on('euser', 649, () => h.fail(`User::Leave(${a(0) | 0})`));
  on('euser', 2082, () => h.r32(a(0) + 4));          // XLeaveException::GetReason
  on('libc', 2, () => {                              // __crt0(int& argc, char**& argv, char**& envp)
    const name = game.exe.toLowerCase();
    const prog = h.heap.alloc(Math.max(16, (name.length + 4) & ~3)), argv = h.heap.alloc(8), envp = h.heap.alloc(4);
    h.putAscii(prog, name);
    h.w32(argv, prog);
    h.w32(a(0), 1); h.w32(a(1), argv); h.w32(a(2), envp);
    return 0;
  });
  for (const o of [158, 159, 180, 182, 183, 184, 202]) {
    on('drtaeabi', o, () => h.fail(`C++ exception/RTTI helper ${h.name('drtaeabi', o)}`));
  }

  // constructors (return this)
  on('euser', 83, () => {                            // TBufBase16(const TUint16*, maxlen)
    const n = wstrlen(a(1));
    h.w32(a(0), ((3 << 28) | n) >>> 0); h.w32(a(0) + 4, a(2));
    core.write(a(0) + 8, core.read(a(1), 2 * n));
    return a(0);
  });
  on('euser', 85, () => { h.w32(a(0), (3 << 28) >>> 0); h.w32(a(0) + 4, a(1)); return a(0); });
  on('euser', 1472, () => { h.w32(a(0), (3 << 28) >>> 0); h.w32(a(0) + 4, a(1)); return a(0); });
  on('euser', 815, () => { h.w32(a(0), (2 << 28) >>> 0); h.w32(a(0) + 4, a(2)); h.w32(a(0) + 8, a(1)); return a(0); });
  on('euser', 1027, () => { h.w32(a(0), ((2 << 28) | a(2)) >>> 0); h.w32(a(0) + 4, a(3)); h.w32(a(0) + 8, a(1)); return a(0); });
  on('euser', 1032, () => { makePtrC(a(0), a(1), strlen8(a(1))); return a(0); });
  on('euser', 1033, () => { makePtrC(a(0), a(1), a(2)); return a(0); });
  on('euser', 1169, () => { makePtrC(a(0), a(1), wstrlen(a(1))); return a(0); });
  on('euser', 1348, () => { h.w32(a(0), a(1)); h.w32(a(0) + 4, a(2)); h.w32(a(0) + 8, a(3)); return a(0); });
  on('euser', 406, () => a(0));

  // accessors
  on('euser', 1719, () => ptr(a(0)));
  on('euser', 1807, () => ptr(a(0)));
  on('euser', 595, () => strlen8(a(0)));
  on('euser', 596, () => wstrlen(a(0)));
  const indexOfBytes = (s, t) => {
    outer: for (let i = 0; i + t.length <= s.length; i++) {
      for (let j = 0; j < t.length; j++) if (s[i + j] !== t[j]) continue outer;
      return i;
    }
    return -1;
  };
  on('euser', 1721, () => { const k = indexOfBytes(read(a(0), false), read(a(1), false)); return k >= 0 ? k : KErrNotFound; });
  const locate = (wide, reverse) => () => {
    const s = wide ? text(a(0)) : text(a(0), false);
    const c = String.fromCharCode(a(1) & 0xFFFF);
    const k = reverse ? s.lastIndexOf(c) : s.indexOf(c);
    return k >= 0 ? k : KErrNotFound;
  };
  on('euser', 1729, locate(false, false));
  on('euser', 1818, locate(true, false));
  on('euser', 1803, locate(true, true));
  const compare = (wide) => () => {
    const x = wide ? text(a(0)) : text(a(0), false), y = wide ? text(a(1)) : text(a(1), false);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      if (x.charCodeAt(i) !== y.charCodeAt(i)) return (x.charCodeAt(i) - y.charCodeAt(i)) >>> 0;
    }
    return (x.length - y.length) >>> 0;
  };
  on('euser', 1733, compare(false));
  on('euser', 1822, compare(true));
  on('euser', 2106, () => {                          // TPtrC16 Left(int): (result*, this, n)
    const [, ln] = header(a(1));
    makePtrC(a(0), ptr(a(1)), Math.min(a(2), ln));
    return a(0);
  });

  // modifiers
  on('euser', 950, () => { write(a(0), core.read(a(1), 2 * wstrlen(a(1))), true); });
  on('euser', 952, () => { write(a(0), wideBytes(text(a(1), false)), true); });
  on('euser', 968, () => { write(a(0), read(a(1), true), true, true); });
  on('euser', 953, () => { write(a(0), read(a(1), true), true); });                     // Copy(TDesC16&)
  on('euser', 951, () => { write(a(0), core.read(a(1), 2 * a(2)), true); });            // Copy(ptr, len)
  on('euser', 967, () => { write(a(0), core.read(a(1), 2 * a(2)), true, true); });      // Append(ptr, len)
  on('euser', 966, () => { write(a(0), Uint8Array.of(a(1) & 0xFF, (a(1) >> 8) & 0xFF), true, true); });
  on('euser', 970, () => { write(a(0), wideBytes(text(a(1)).toLowerCase()), true); });  // CopyLC
  on('euser', 971, () => { write(a(0), wideBytes(text(a(1)).toUpperCase()), true); });  // CopyUC
  on('euser', 987, () => { write(a(0), wideBytes(text(a(0)).toLowerCase()), true); });
  on('euser', 1612, () => String.fromCharCode(h.r32(a(0)) & 0xFFFF).toLowerCase().charCodeAt(0));
  const formatList = (wide) => () => {
    const s = symbianFormat(h, wide ? text(a(1)) : text(a(1), false), a(2), text);
    write(a(0), wide ? wideBytes(s) : Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xFF), wide);
  };
  on('euser', 725, formatList(false));
  on('euser', 933, formatList(true));

  // TLex8 / TLex16: { iNext, iBuf, iEnd, iMark }
  const lexAssign = (wide) => () => {
    const p = ptr(a(1)), [, ln] = header(a(1));
    [p, p, p + ln * (wide ? 2 : 1), p].forEach((v, k) => h.w32(a(0) + 4 * k, v));
  };
  const lexVal = (wide, signed, radixArg) => () => {
    const unit = wide ? 2 : 1;
    const nxt = h.r32(a(0)), end = h.r32(a(0) + 8);
    const raw = end > nxt ? core.read(nxt, end - nxt) : new Uint8Array(0);
    let s = '';
    if (wide) for (let i = 0; i < raw.length; i += 2) s += String.fromCharCode(raw[i] | (raw[i + 1] << 8));
    else s = String.fromCharCode(...raw);
    const radix = radixArg ? a(2) : 10;
    let k = 0, neg = false;
    if (signed && k < s.length && '+-'.includes(s[k])) { neg = s[k] === '-'; k++; }
    const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, radix);
    const start = k;
    while (k < s.length && digits.includes(s[k].toLowerCase())) k++;
    if (k === start) return KErrGeneral;
    const v = Number(BigInt.asUintN(32, BigInt(parseInt(s.slice(start, k), radix))));
    h.w32(a(1), neg ? -v : v);
    h.w32(a(0), nxt + k * unit);
    return KErrNone;
  };
  on('euser', 810, lexAssign(false));
  on('euser', 1016, lexAssign(true));
  on('euser', 804, lexVal(false, true, false));
  on('euser', 805, lexVal(false, false, true));
  on('euser', 1011, lexVal(true, false, true));

  // memory
  on('euser', 646, () => h.heap.alloc(a(0)));
  on('euser', 644, () => { h.heap.release(a(0)); });
  on('euser', 665, () => {
    if (!st.allocator) {
      const al = h.ngi.obj('RAllocator');
      al.methods = new Map([
        [0, () => h.heap.alloc(a(1))], [1, () => { h.heap.release(a(1)); }], [2, () => h.heap.realloc(a(1), a(2))],
        [3, () => h.heap.sizes.get(a(1)) || 0], [4, () => 0], [5, () => undefined],
        [6, () => { let t = 0; for (const v of h.heap.sizes.values()) t += v; h.w32(a(1), t); return h.heap.sizes.size; }],
        [7, () => { h.w32(a(1), 0x100000); return 0x1000000; }], [8, () => 0],
      ]);
      st.allocator = al;
    }
    return st.allocator.addr;
  });
  on('euser', 667, () => undefined);                 // IMB_Range: the core re-reads code each time
  const memCopy = () => { if (a(2)) core.write(a(0), core.read(a(1), a(2))); return a(0); };
  on('euser', 1953, memCopy);
  on('euser', 1954, memCopy);
  on('euser', 1955, () => { if (a(2)) core.write(a(0), new Uint8Array(a(2)).fill(a(1) & 0xFF)); return a(0); });
  on('euser', 1951, () => { if (a(1)) core.write(a(0), new Uint8Array(a(1))); return a(0); });
  on('euser', 1952, () => {
    const x = a(1) ? core.read(a(0), a(1)) : new Uint8Array(0), y = a(3) ? core.read(a(2), a(3)) : new Uint8Array(0);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return (x[i] - y[i]) >>> 0;
    return (x.length - y.length) >>> 0;
  });

  // time
  on('euser', 645, () => { h.ngi.sleep(a(0)); });   // User::After
  on('euser', 674, () => Math.floor(h.ngi.nowUs / 15625) >>> 0);
  const homeTime = () => {                           // TTime::HomeTime: int64 us since 0 AD
    const t = BigInt(h.wallClock()) * 1000000n + BigInt(h.ngi.nowUs % 1e6) + 62168256000n * 1000000n;
    h.w32(a(0), Number(t & 0xFFFFFFFFn)); h.w32(a(0) + 4, Number(t >> 32n));
  };
  on('euser', 859, homeTime);
  on('euser', 855, homeTime);
  on('euser', 1324, () => {                          // RProcess::Create(this, exe, cmdline, owner)
    // Other processes are not emulated: the handle is real, the process never runs.
    h.log(`[proc] RProcess::Create(${text(a(1))}, ${text(a(2))}) -> not run`);
    h.w32(a(0), newHandle());
    return KErrNone;
  });
  on('euser', 1326, () => undefined);                // RProcess::Resume                        // TTime::UniversalTime: the clock is UTC already
  on('euser', 590, () => { h.ngi.sleep(a(0)); });   // User::AfterHighRes
  on('euser', 1679, () => {                          // TTime::DateTime() const -> TDateTime (hidden r0, this r1)
    const us = ((BigInt(h.r32(a(1) + 4)) << 32n) | BigInt(h.r32(a(1)))) - 62168256000n * 1000000n;
    const d = new Date(Number(us / 1000n));
    [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(),
      Number(us % 1000000n)].forEach((v, i) => h.w32(a(0) + 4 * i, v));
    return a(0);
  });

  // TLS
  on('euser', 1232, () => st.tls.get(a(0)) || 0);
  on('euser', 1237, () => { st.tls.set(a(0), a(1)); return KErrNone; });
  on('euser', 1210, () => { st.tls.delete(a(0)); });

  // handles / chunks
  on('euser', 120, () => undefined);
  const chunkCreate = (named) => () => {
    const [name, size, mx] = named ? [text(a(1)), a(2), a(3)] : [null, a(1), a(2)];
    const base = h.m.allocChunk(Math.max(size, mx));
    const hd = newHandle();
    st.chunks.set(hd, [base, size, name]);
    if (name) st.globalChunks.set(name, hd);
    h.w32(a(0), hd);
    return KErrNone;
  };
  on('euser', 903, chunkCreate(false));
  on('euser', 905, chunkCreate(false));
  on('euser', 904, chunkCreate(true));
  on('euser', 902, () => {
    const hd = st.globalChunks.get(text(a(1)));
    if (!hd) return KErrNotFound;
    h.w32(a(0), hd);
    return KErrNone;
  });
  on('euser', 1702, () => st.chunks.get(h.r32(a(0)))[0]);
  on('euser', 1703, () => st.chunks.get(h.r32(a(0)))[1]);

  // process
  on('euser', 1854, () => game.uid);
  on('euser', 1979, () => 1);
  on('euser', 1849, () => { h.w32(a(0), 0x101); h.w32(a(0) + 4, 0); return a(0); });
  const fileNameResult = (s) => {                    // TFileName via hidden result pointer
    const res = a(0);
    h.w32(res, ((3 << 28) | s.length) >>> 0); h.w32(res + 4, 256);
    core.write(res + 8, wideBytes(s));
    return res;
  };
  on('euser', 1853, () => fileNameResult(EXE_PATH));
  on('euser', 1846, () => {
    const img = h.m.exe.image.h;
    [0x8000, img.text_size, 0x8000 + img.text_size, img.code_size - img.text_size, 0x400000, img.data_size,
      0x400000 + img.data_size, img.bss].forEach((v, i) => h.w32(a(1) + 4 * i, v));
    return KErrNone;
  });

  // libraries
  const libLoad = () => {
    const mod = h.m.loadDll(text(a(1)));
    if (!mod) return KErrNotFound;
    const hd = newHandle();
    st.libs.set(hd, mod);
    h.w32(a(0), hd);
    return KErrNone;
  };
  on('euser', 1308, libLoad);
  on('euser', 1309, libLoad);
  on('euser', 1311, () => undefined);
  on('euser', 1838, () => { const m = st.libs.get(h.r32(a(0))); return m ? m.export(a(1)) : 0; });
  on('euser', 1304, () => {
    const m = st.libs.get(h.r32(a(0)));
    if (!m) return KErrGeneral;
    h.w32(a(1), m.image.h.code_size); h.w32(a(2), m.image.h.data_size + m.image.h.bss);
    return KErrNone;
  });
  on('euser', 1839, () => { const m = st.libs.get(h.r32(a(1))); return fileNameResult('E:\\sys\\bin\\' + (m ? m.image.name : 'unknown.dll')); });
  on('euser', 215, () => KErrNotFound);

  // file server
  on('efsrv', 68, () => KErrNone);
  on('efsrv', 118, () => a(0));
  on('efsrv', 115, () => { st.parses.set(a(0), text(a(1))); return KErrNone; });
  on('efsrv', 190, () => {                           // TPtrC NameAndExt(): (result*, this)
    const tail = (st.parses.get(a(1)) || '').replace(/\//g, '\\').split('\\').pop();
    makePtrC(a(0), h.allocWide(tail), tail.length);
    return a(0);
  });
  on('efsrv', 93, () => {                            // RFile::Open(this, RFs&, name, mode)
    const name = text(a(2));
    const data = h.vfs.get(name);
    h.log(`[rfile] Open(${name}) -> ${data ? 'ok' : 'missing'}`);
    if (!data) return KErrNotFound;
    const hd = newHandle();                          // RFile is just a handle; callers copy it around
    st.files.set(hd, new OpenFile(h.vfs, name, data, false));
    h.w32(a(0), hd);
    return KErrNone;
  });
  const file = () => st.files.get(h.r32(a(0)));
  on('efsrv', 257, () => { const f = file(); if (!f) return KErrGeneral; write(a(1), f.read(Math.min(a(2), maxlen(a(1)))), false); return KErrNone; });
  on('efsrv', 263, () => {
    const f = file();
    if (!f) return KErrGeneral;
    const whence = { 1: 0, 2: 1, 3: 2 }[a(1)] ?? 0;
    h.w32(a(2), f.seek(h.r32(a(2)) | 0, whence));
    return KErrNone;
  });
  on('efsrv', 264, () => { const f = file(); if (!f) return KErrGeneral; h.w32(a(1), f.size); return KErrNone; });
  on('efsrv', 300, () => { st.files.delete(h.r32(a(0))); });
}

/** TDes::FormatList subset: %d %i %u %x %X %c %s (zero-terminated) %S (descriptor*). */
function symbianFormat(h, fmt, va, text) {
  let out = '', i = 0;
  const next = () => { const v = h.r32(va); va += 4; return v; };
  while (i < fmt.length) {
    const ch = fmt[i];
    if (ch !== '%') { out += ch; i++; continue; }
    let j = i + 1;
    while (j < fmt.length && '-+ #0123456789.*l'.includes(fmt[j])) j++;
    const conv = fmt[j] || '';
    const flags = fmt.slice(i + 1, j).replace(/l/g, '');
    i = j + 1;
    const m = /^([-0]*)(\d*)/.exec(flags);
    const width = m[2] ? +m[2] : 0, zero = m[1].includes('0'), left = m[1].includes('-');
    const pad = (s) => (s.length >= width ? s : left ? s + ' '.repeat(width - s.length) : (zero ? '0' : ' ').repeat(width - s.length) + s);
    switch (conv) {
      case '%': out += '%'; break;
      case 'd': case 'i': out += pad(String(next() | 0)); break;
      case 'u': out += pad(String(next() >>> 0)); break;
      case 'x': out += pad((next() >>> 0).toString(16)); break;
      case 'X': out += pad((next() >>> 0).toString(16).toUpperCase()); break;
      case 'o': out += pad((next() >>> 0).toString(8)); break;
      case 'c': out += String.fromCharCode(next() & 0xFFFF); break;
      case 'S': out += text(next()); break;
      case 's': out += h.cstr(next()); break;
      default: out += fmt.slice(i - (j - i + 1), i);
    }
  }
  return out;
}
