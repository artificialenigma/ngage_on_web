// P.I.P.S. libc / libm / libpthread / libdl, scppnwdl, soft-float and RVCT helpers.
// Mirrors port/proto/hle_libc.py.

import { OpenFile } from './vfs.js';

const M32 = 0xFFFFFFFF;
const f64 = new Float64Array(1), f64w = new Uint32Array(f64.buffer);
const f32 = new Float32Array(1), f32w = new Uint32Array(f32.buffer);

export const dOf = (lo, hi) => { f64w[0] = lo; f64w[1] = hi; return f64[0]; };
export const dRet = (x) => { f64[0] = x; return [f64w[0], f64w[1]]; };
export const fOf = (w) => { f32w[0] = w; return f32[0]; };
export const fRet = (x) => { f32[0] = x; return f32w[0]; };

/** Float -> int with ARM saturation: NaN -> 0, out of range (incl. +-inf) -> lo/hi. */
export function clampInt(x, lo, hi) {
  if (x !== x) return 0;
  if (x >= hi) return hi;
  if (x <= lo) return lo;
  return Math.trunc(x);
}

const ll = (lo, hi) => (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
const sll = (v) => BigInt.asIntN(64, v);
const llRet = (v) => { v = BigInt.asUintN(64, v); return [Number(v & 0xFFFFFFFFn), Number(v >> 32n)]; };

/** printf-style formatting; next() yields u32 args, nextD() yields doubles (8-byte aligned). */
export function formatPrintf(fmt, next, nextD, str, wstr, wide = false) {
  let out = '', i = 0;
  while (i < fmt.length) {
    const ch = fmt[i];
    if (ch !== '%') { out += ch; i++; continue; }
    let j = i + 1;
    while (j < fmt.length && '-+ #0123456789.*hlLqjzt'.includes(fmt[j])) j++;
    const conv = fmt[j] || '';
    let flags = fmt.slice(i + 1, j);
    i = j + 1;
    if (flags.includes('*')) flags = flags.replace('*', String(next() | 0));
    const isLL = flags.includes('ll') || flags.includes('q');
    const isLong = flags.includes('l');
    const spec = flags.replace(/[hlLqjzt]/g, '');
    const m = /^([-+ #0]*)(\d*)(?:\.(\d+))?$/.exec(spec) || ['', '', '', undefined];
    const fl = m[1], width = m[2] ? +m[2] : 0, prec = m[3] !== undefined ? +m[3] : undefined;
    const pad = (s, numeric) => {
      if (s.length >= width) return s;
      if (fl.includes('-')) return s + ' '.repeat(width - s.length);
      if (numeric && fl.includes('0') && prec === undefined) {
        const sign = /^[-+ ]/.test(s) ? s[0] : '';
        return sign + '0'.repeat(width - s.length) + s.slice(sign.length);
      }
      return ' '.repeat(width - s.length) + s;
    };
    const intDigits = (s) => (prec !== undefined && s.replace('-', '').length < prec
      ? (s.startsWith('-') ? '-' : '') + '0'.repeat(prec - s.replace('-', '').length) + s.replace('-', '') : s);
    switch (conv) {
      case '%': out += '%'; break;
      case 'd': case 'i': {
        let v = isLL ? sll(ll(next(), next())) : BigInt(next() | 0);
        let s = intDigits(v.toString());
        if (v >= 0n && fl.includes('+')) s = '+' + s; else if (v >= 0n && fl.includes(' ')) s = ' ' + s;
        out += pad(s, true); break;
      }
      case 'u': case 'x': case 'X': case 'o': {
        const v = isLL ? ll(next(), next()) : BigInt(next() >>> 0);
        let s = v.toString(conv === 'o' ? 8 : conv === 'u' ? 10 : 16);
        if (conv === 'X') s = s.toUpperCase();
        s = intDigits(s);
        if (fl.includes('#') && v !== 0n && conv !== 'u') s = (conv === 'o' ? '0' : conv === 'x' ? '0x' : '0X') + s;
        out += pad(s, true); break;
      }
      case 'c': out += pad(String.fromCharCode(next() & 0xFFFF), false); break;
      case 's': {
        const p = next();
        let s = p ? (isLong ? wstr(p) : str(p)) : '(null)';        // C: %s is char* even in wprintf
        if (prec !== undefined) s = s.slice(0, prec);
        out += pad(s, false); break;
      }
      case 'S': out += pad(wstr(next()), false); break;
      case 'f': case 'F': case 'e': case 'E': case 'g': case 'G': {
        const v = nextD();
        const p = prec === undefined ? 6 : prec;
        let s;
        if (conv === 'f' || conv === 'F') s = v.toFixed(p);
        else if (conv === 'e' || conv === 'E') s = v.toExponential(p).replace(/e([+-])(\d)$/, 'e$10$2');
        else s = String(Number(v.toPrecision(p || 1)));
        if (conv === 'E' || conv === 'G') s = s.toUpperCase();
        if (v >= 0 && fl.includes('+')) s = '+' + s;
        out += pad(s, true); break;
      }
      case 'p': out += '0x' + (next() >>> 0).toString(16); break;
      default: out += '%' + flags + conv;
    }
  }
  return out;
}

export function registerLibc(h) {
  const core = h.core, a = (i) => h.a(i);
  const on = (dll, o, fn) => h.on(dll, o, fn);
  const put = (addr, bytes) => core.write(addr, bytes);
  const mem = (addr, n) => core.read(addr, n);
  const state = { files: new Map(), nextFd: 3, tls: new Map(), nextKey: 1, dirs: new Map(), dl: new Map(),
    rngState: 1, tm: 0 };
  h.libcState = state;

  // flags as for a CMP; registers untouched
  const setFlags = (n, z, c, v) => {
    const cpsr = core.reg(16) & 0x0FFFFFFF;
    core.setReg(16, (cpsr | (n << 31) | (z << 30) | (c << 29) | (v << 28)) >>> 0);
  };
  const cmpFlags = (x, y) => {                       // __aeabi_cdcmple semantics
    if (x !== x || y !== y) setFlags(0, 0, 1, 0);
    else if (x === y) setFlags(0, 1, 1, 0);
    else if (x < y) setFlags(1, 0, 0, 0);
    else setFlags(0, 0, 1, 0);
  };

  // --- deterministic rand(): the prototype uses Python's Random; any LCG works as long as the
  // DRM-relevant values pass. Use a 31-bit LCG seeded by srand.
  const rand = () => {
    state.rngState = (Math.imul(state.rngState, 1103515245) + 12345) >>> 0;
    return (state.rngState >>> 1) & 0x7FFFFFFE;
  };

  // --- memory
  on('libc', 221, () => h.heap.alloc(a(0)));
  on('libc', 98, () => { h.heap.release(a(0)); });
  on('libc', 276, () => h.heap.realloc(a(0), a(1)));
  for (const o of [5, 7]) on('scppnwdl', o, () => h.heap.alloc(a(0)));
  for (const o of [1, 3]) on('scppnwdl', o, () => { h.heap.release(a(0)); });
  const memcpy = () => { if (a(2)) put(a(0), mem(a(1), a(2))); return a(0); };
  const memset = (dst, n, v) => { if (n) put(dst, new Uint8Array(n).fill(v & 0xFF)); return dst; };
  for (const o of [146, 147, 149, 150]) on('drtaeabi', o, memcpy);
  on('drtaeabi', 143, () => memset(a(0), a(1), 0));
  on('drtaeabi', 144, () => memset(a(0), a(1), 0));
  on('drtaeabi', 152, () => memset(a(0), a(1), a(2)));
  const cmpBytes = (x, y) => {
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? M32 : 1;
    return x.length === y.length ? 0 : (x.length < y.length ? M32 : 1);
  };
  on('libc', 232, () => cmpBytes(mem(a(0), a(2)), mem(a(1), a(2))));

  // --- integer division (r0 = quotient, r1 = remainder)
  on('drtaeabi', 135, () => {
    const n = a(0) | 0, d = a(1) | 0;
    if (d === 0) return [0, n];
    const q = (n / d) | 0;
    return [q, n - Math.imul(q, d)];
  });
  on('drtaeabi', 155, () => {
    const n = a(0), d = a(1);
    return d === 0 ? [0, n] : [Math.floor(n / d), n % d];
  });

  // --- C++ runtime (array helpers run natively from guestlib)
  on('drtaeabi', 204, () => a(0));
  on('drtaeabi', 189, () => h.fail('__cxa_pure_virtual called'));

  // --- soft float: double
  const dbin = (op) => () => dRet(op(dOf(a(0), a(1)), dOf(a(2), a(3))));
  const safeDiv = (x, y) => x / y;                   // JS already follows IEEE (inf/nan)
  on('dfpaeabi', 12, dbin((x, y) => x + y));
  on('dfpaeabi', 23, dbin((x, y) => x - y));
  on('dfpaeabi', 22, dbin((x, y) => y - x));
  on('dfpaeabi', 20, dbin((x, y) => x * y));
  on('dfpaeabi', 19, dbin(safeDiv));
  on('dfpaeabi', 1, () => cmpFlags(dOf(a(0), a(1)), dOf(a(2), a(3))));
  on('dfpaeabi', 2, () => cmpFlags(dOf(a(0), a(1)), dOf(a(2), a(3))));
  on('dfpaeabi', 3, () => cmpFlags(dOf(a(2), a(3)), dOf(a(0), a(1))));
  on('dfpaeabi', 7, () => fRet(dOf(a(0), a(1))));
  on('dfpaeabi', 8, () => clampInt(dOf(a(0), a(1)), -(2 ** 31), 2 ** 31 - 1) >>> 0);
  on('dfpaeabi', 10, () => clampInt(dOf(a(0), a(1)), 0, M32) >>> 0);
  on('dfpaeabi', 41, () => dRet(a(0) | 0));
  on('dfpaeabi', 45, () => dRet(a(0)));
  on('dfpaeabi', 24, () => dRet(fOf(a(0))));
  // single
  const fbin = (op) => () => fRet(op(fOf(a(0)), fOf(a(1))));
  on('dfpaeabi', 29, fbin((x, y) => x + y));
  on('dfpaeabi', 40, fbin((x, y) => x - y));
  on('dfpaeabi', 39, fbin((x, y) => y - x));
  on('dfpaeabi', 37, fbin((x, y) => x * y));
  on('dfpaeabi', 36, fbin(safeDiv));
  on('dfpaeabi', 4, () => cmpFlags(fOf(a(0)), fOf(a(1))));
  on('dfpaeabi', 5, () => cmpFlags(fOf(a(0)), fOf(a(1))));
  on('dfpaeabi', 6, () => cmpFlags(fOf(a(1)), fOf(a(0))));
  on('dfpaeabi', 25, () => clampInt(fOf(a(0)), -(2 ** 31), 2 ** 31 - 1) >>> 0);
  on('dfpaeabi', 27, () => clampInt(fOf(a(0)), 0, M32) >>> 0);
  on('dfpaeabi', 42, () => fRet(a(0) | 0));
  on('dfpaeabi', 46, () => fRet(a(0)));

  // --- libm (doubles in r0:r1 [, r2:r3])
  const m1 = (fn) => () => dRet(fn(dOf(a(0), a(1))));
  [[22, Math.acos], [26, Math.asin], [30, Math.atan], [43, Math.cos], [52, Math.exp], [66, Math.floor],
    [141, Math.sin], [145, Math.sqrt], [147, Math.tan]].forEach(([o, fn]) => on('libm', o, m1(fn)));
  on('libm', 31, () => dRet(Math.atan2(dOf(a(0), a(1)), dOf(a(2), a(3)))));
  on('libm', 122, () => dRet(Math.pow(dOf(a(0), a(1)), dOf(a(2), a(3)))));

  // --- RVCT 2.2 helpers
  on('drtrvct2_2', 60, () => llRet(-ll(a(0), a(1))));
  on('drtrvct2_2', 44, () => llRet(ll(a(0), a(1)) + BigInt(a(2) | 0)));
  const llCmp = () => {                              // __ARM_ll_cmpge / cmpu: flags only
    const x = ll(a(0), a(1)), y = ll(a(2), a(3));
    setFlags(sll(x) < sll(y) ? 1 : 0, x === y ? 1 : 0, x >= y ? 1 : 0, 0);
    return undefined;
  };
  on('drtrvct2_2', 49, llCmp);
  on('drtrvct2_2', 51, llCmp);
  on('drtrvct2_2', 50, () => {                       // __ARM_ll_cmple: flags as for CMP r2:r3, r0:r1 (operands swapped)
    const x = ll(a(2), a(3)), y = ll(a(0), a(1));
    setFlags(sll(x) < sll(y) ? 1 : 0, x === y ? 1 : 0, x >= y ? 1 : 0, 0);
    return undefined;
  });
  on('drtrvct2_2', 28, () => {                       // __ARM_switch8: index in r3, table after BLX
    const tbl = core.reg(14) & ~1;
    const n = core.r8(tbl);
    const i = a(3);
    const off = core.r8(tbl + 1 + (i < n ? i : n));
    core.setReg(14, ((tbl + 2 * off) | 1) >>> 0);
    return undefined;
  });
  on('drtaeabi', 157, () => {                                                          // __aeabi_uldivmod
    const n = ll(a(0), a(1)), d = ll(a(2), a(3));
    const [q, r] = d === 0n ? [0n, n] : [n / d, n % d];
    const [rl, rh] = llRet(r);
    core.setReg(2, rl);
    core.setReg(3, rh);
    return llRet(q);
  });
  const vecFree = h.syntheticFn('vec-delete-free', () => { h.heap.release(a(0)); return undefined; });
  on('drtaeabi', 168, () => {                        // __aeabi_vec_delete(ptr, dtor): cookie {size, count} before ptr
    const p = a(0), dtor = a(1);
    if (!p) return undefined;
    const size = h.r32(p - 8), count = h.r32(p - 4), calls = [];
    if (dtor) for (let k = count - 1; k >= 0; k--) calls.push([dtor, [p + k * size]]);
    calls.push([vecFree, [p - 8]]);
    return h.runGuestCalls(calls, undefined);
  });
  on('drtaeabi', 136, () => llRet(sll(ll(a(0), a(1))) >> BigInt(a(2) & 0xFF)));          // __aeabi_lasr
  on('drtaeabi', 139, () => {                                                          // __aeabi_ldivmod
    const n = sll(ll(a(0), a(1))), d = sll(ll(a(2), a(3)));
    let q = 0n, r = n;
    if (d !== 0n) { q = n / d; r = n - q * d; }
    const [rl, rh] = llRet(r);
    core.setReg(2, rl);
    core.setReg(3, rh);
    return llRet(q);
  });

  // --- ctype / strings
  const ctype = (pred) => () => (a(0) < 256 && pred(String.fromCharCode(a(0))) ? 1 : 0);
  on('libc', 181, ctype((c) => /[A-Za-z0-9]/.test(c)));
  on('libc', 182, ctype((c) => /[A-Za-z]/.test(c)));
  on('libc', 185, ctype((c) => /[0-9]/.test(c)));
  on('libc', 187, ctype((c) => /[a-z]/.test(c)));
  on('libc', 191, ctype((c) => ' \t\n\r\f\v'.includes(c)));
  const atoi = () => {
    const m = /^\s*([+-]?\d+)/.exec(h.cstr(a(0)));
    return m ? (parseInt(m[1], 10) >>> 0) : 0;
  };
  on('libc', 36, atoi);
  on('libc', 37, atoi);
  const cb = (p) => h.cstrBytes(p);
  on('libc', 361, () => cb(a(0)).length);
  on('libc', 350, () => cmpBytes(cb(a(0)), cb(a(1))));
  on('libc', 351, () => cmpBytes(cb(a(0)), cb(a(1))));
  on('libc', 364, () => cmpBytes(cb(a(0)).slice(0, a(2)), cb(a(1)).slice(0, a(2))));
  const lower = (b) => b.map((c) => (c >= 65 && c <= 90 ? c + 32 : c));
  on('libc', 346, () => cmpBytes(lower(cb(a(0))), lower(cb(a(1)))));
  const withNul = (b) => { const o = new Uint8Array(b.length + 1); o.set(b); return o; };
  on('libc', 352, () => { put(a(0), withNul(cb(a(1)))); return a(0); });
  on('libc', 345, () => { const s = cb(a(1)); put(a(0), withNul(s)); return a(0) + s.length; });
  on('libc', 348, () => { const d = a(0); put(d + cb(d).length, withNul(cb(a(1)))); return d; });
  on('libc', 349, () => {
    const s = cb(a(0)), c = a(1) & 0xFF;
    if (!c) return a(0) + s.length;
    const k = s.indexOf(c);
    return k >= 0 ? a(0) + k : 0;
  });
  on('libc', 371, () => {
    const s = cb(a(0)), c = a(1) & 0xFF;
    if (!c) return a(0) + s.length;
    const k = s.lastIndexOf(c);
    return k >= 0 ? a(0) + k : 0;
  });
  const findSub = (s, t) => {
    outer: for (let i = 0; i + t.length <= s.length; i++) {
      for (let j = 0; j < t.length; j++) if (s[i + j] !== t[j]) continue outer;
      return i;
    }
    return -1;
  };
  on('libc', 374, () => { const k = findSub(cb(a(0)), cb(a(1))); return k >= 0 ? a(0) + k : 0; });
  const spn = (accept) => () => {
    const s = cb(a(0)), set = new Set(cb(a(1)));
    let n = 0;
    while (n < s.length && set.has(s[n]) === accept) n++;
    return n;
  };
  on('libc', 373, spn(true));
  on('libc', 353, spn(false));
  on('libc', 369, () => {
    const s = cb(a(0)), set = new Set(cb(a(1)));
    for (let k = 0; k < s.length; k++) if (set.has(s[k])) return a(0) + k;
    return 0;
  });
  on('libc', 444, () => { h.putWide(a(0), h.wstr(a(1))); return a(0); });
  on('libc', 439, () => {
    const x = h.wstr(a(0)).toLowerCase(), y = h.wstr(a(1)).toLowerCase();
    return x === y ? 0 : (x < y ? M32 : 1);
  });
  on('libc', 380, () => {                            // strtol(s, char** end, base), saturating
    const s = h.cstr(a(0));
    let base = a(2), k = s.length - s.replace(/^[ \t\n]+/, '').length;
    const start = k, neg = s[k] === '-';
    if (s[k] === '+' || s[k] === '-') k++;
    if ((base === 0 || base === 16) && s.slice(k, k + 2).toLowerCase() === '0x') { k += 2; base = 16; }
    base = base || (s[k] === '0' ? 8 : 10);
    const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, base);
    const d0 = k;
    while (k < s.length && digits.includes(s[k].toLowerCase())) k++;
    if (a(1)) h.w32(a(1), a(0) + (k > d0 ? k : start));
    let v = k > d0 ? parseInt(s.slice(d0, k), base) : 0;
    if (neg) v = -v;
    return Math.max(-0x80000000, Math.min(0x7FFFFFFF, v)) >>> 0;
  });
  on('libc', 365, () => {                            // strncpy
    const src = cb(a(1)).slice(0, a(2)), out = new Uint8Array(a(2));
    out.set(src);
    put(a(0), out);
    return a(0);
  });
  const W = 1 << 20;
  on('libc', 448, () => h.wstr(a(0), W).length);    // wcslen
  on('libc', 442, () => {                            // wcscmp
    const x = h.wstr(a(0), W), y = h.wstr(a(1), W);
    return x === y ? 0 : (x < y ? M32 : 1);
  });
  on('libc', 440, () => { const d = a(0); h.putWide(d + 2 * h.wstr(d, W).length, h.wstr(a(1), W)); return d; });
  on('libc', 452, () => {                            // wcsncpy
    const src = h.wstr(a(1), a(2));
    h.putWide(a(0), src + '\0'.repeat(a(2) - src.length), false);
    return a(0);
  });
  on('libc', 228, () => {                            // mbstowcs(dst, src, n)
    let s = h.cstr(a(1));
    if (a(0)) { s = s.slice(0, a(2)); h.putWide(a(0), s, s.length < a(2)); }
    return s.length;
  });
  on('libc', 467, () => {                            // wcstombs(dst, src, n)
    let s = h.wstr(a(1), W).replace(/[^\x00-\xff]/g, '?');
    if (a(0)) { s = s.slice(0, a(2)); h.putAscii(a(0), s, s.length < a(2)); }
    return s.length;
  });
  on('libc', 384, () => {                            // strtoul(s, char** end, base)
    const s = h.cstr(a(0));
    let base = a(2), k = 0;
    while (k < s.length && ' \t\n'.includes(s[k])) k++;
    const start = k;
    if ((base === 0 || base === 16) && s.slice(k, k + 2).toLowerCase() === '0x') { k += 2; base = 16; }
    base = base || 10;
    const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, base);
    const d0 = k;
    while (k < s.length && digits.includes(s[k].toLowerCase())) k++;
    if (a(1)) h.w32(a(1), a(0) + (k > d0 ? k : start));
    return k > d0 ? Number(BigInt.asUintN(32, BigInt(parseInt(s.slice(d0, k), base)))) : 0;
  });

  const printfArgs = (first) => {
    let ai = first;
    return {
      next: () => h.a(ai++),
      nextD: () => { if (ai % 2) ai++; const lo = h.a(ai++), hi = h.a(ai++); return dOf(lo, hi); },
    };
  };
  on('libc', 340, () => {
    const { next, nextD } = printfArgs(2);
    const s = formatPrintf(h.cstr(a(1)), next, nextD, (p) => h.cstr(p), (p) => h.wstr(p));
    h.putAscii(a(0), s);
    return s.length;
  });
  on('libc', 390, () => {                            // swprintf(buf, maxlen, fmt, ...)
    const { next, nextD } = printfArgs(3);
    const s = formatPrintf(h.wstr(a(2)), next, nextD, (p) => h.cstr(p), (p) => h.wstr(p), true)
      .slice(0, Math.max(0, a(1) - 1));
    h.putWide(a(0), s);
    return s.length;
  });

  // --- random / time
  on('libc', 341, () => { state.rngState = a(0) >>> 0; });
  on('libc', 270, rand);
  on('libc', 271, rand);
  on('libc', 397, () => { const t = h.wallClock(); if (a(0)) h.w32(a(0), t); return t; });
  on('libc', 216, () => {
    const d = new Date(h.r32(a(0)) * 1000);
    if (!state.tm) state.tm = h.heap.alloc(44);
    const start = Date.UTC(d.getUTCFullYear(), 0, 1);
    const yday = Math.floor((d - start) / 86400000);
    const vals = [d.getUTCSeconds(), d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth(),
      d.getUTCFullYear() - 1900, d.getUTCDay(), yday, 0];
    vals.forEach((v, i) => h.w32(state.tm + 4 * i, v));
    return state.tm;
  });
  on('libc', 358, () => {                            // strftime(buf, max, fmt, tm*): common codes only
    const v = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => h.r32(a(3) + 4 * i) | 0);
    const two = (n) => String(n).padStart(2, '0');
    const s = h.cstr(a(2)).replace(/%([YmdHMSyj%])/g, (_, c) => ({
      Y: String(v[5] + 1900), m: two(v[4] + 1), d: two(v[3]), H: two(v[2]), M: two(v[1]), S: two(v[0]),
      y: two((v[5] + 1900) % 100), j: String(v[7] + 1).padStart(3, '0'), '%': '%',
    }[c])).slice(0, Math.max(0, a(1) - 1));
    h.putAscii(a(0), s);
    return s.length;
  });

  // --- pthread (single-threaded)
  on('libpthread', 28, () => { h.w32(a(0), state.nextKey++); return 0; });
  on('libpthread', 29, () => { state.tls.delete(a(0)); return 0; });
  on('libpthread', 26, () => state.tls.get(a(0)) || 0);
  on('libpthread', 45, () => { state.tls.set(a(0), a(1)); return 0; });
  on('libpthread', 32, () => 0);
  on('libpthread', 35, () => 0);

  // --- stdio
  const open = (name, mode, stream) => {
    const write = /[wa+]/.test(mode);
    if (write && h.vfs.isSystemPath(name)) {
      h.log(`[io] open ${name} ${mode} -> denied (read-only system path)`);
      return stream ? 0 : M32;
    }
    let data = h.vfs.get(name);
    if (!data && !write) { h.log(`[io] open ${name} -> missing`); return stream ? 0 : M32; }
    if (mode.includes('w')) data = new Uint8Array(0);
    data = data ? data.slice() : new Uint8Array(0);
    const f = new OpenFile(h.vfs, name, data, write);
    if (mode.includes('a')) f.seek(0, 2);
    h.log(`[io] open ${name} ${mode}`);
    const handle = stream ? h.heap.alloc(16) : state.nextFd++;
    state.files.set(handle, f);
    return handle;
  };
  on('libc', 90, () => open(h.cstr(a(0)), h.cstr(a(1)), true));
  on('libc', 489, () => {                            // wopen(path, flags, mode)
    const fl = a(1);
    let mode = (fl & 3) === 0 ? 'rb' : (fl & 2 ? 'r+b' : 'wb');
    if (fl & 0x200) mode = (fl & 0x400) ? 'wb' : (fl & 8) ? 'ab' : 'r+b';
    return open(h.wstr(a(0)), mode, false);
  });
  on('libc', 97, () => {                             // fread(ptr, size, n, FILE*)
    const f = state.files.get(a(3));
    if (!f) return 0;
    const size = a(1), data = f.read(size * a(2));
    put(a(0), data);
    return size ? Math.floor(data.length / size) : 0;
  });
  on('libc', 113, () => {
    const f = state.files.get(a(3));
    if (!f) return 0;
    f.write(mem(a(0), a(1) * a(2)));
    return a(2);
  });
  on('libc', 102, () => { const f = state.files.get(a(0)); if (!f) return M32; f.seek(a(1) | 0, a(2)); return 0; });
  on('libc', 106, () => { const f = state.files.get(a(0)); return f ? f.pos : M32; });
  on('libc', 81, () => 0);
  const close = () => { const f = state.files.get(a(0)); if (f) { f.close(); state.files.delete(a(0)); } return 0; };
  on('libc', 75, close);
  on('libc', 57, close);
  on('libc', 272, () => {
    const f = state.files.get(a(0));
    if (!f) return M32;
    const data = f.read(a(2));
    put(a(1), data);
    return data.length;
  });
  on('libc', 219, () => {                           // lseek(fd, off_t offset [r2:r3], whence [stack]): off_t is 64-bit
    const f = state.files.get(a(0));
    if (!f) return [M32, M32];
    return llRet(BigInt(f.seek(Number(sll(ll(a(2), a(3)))), a(4))));
  });
  on('libc', 72, () => h.exit(a(0) | 0));

  // --- directories
  on('libc', 252, () => {
    const name = h.cstr(a(0));
    const key = h.vfs.key(name.replace(/[\\/]+$/, '') + '\\x').slice(0, -1);
    if (!key.startsWith('private/')) { h.log(`[io] opendir ${name} -> missing`); return 0; }
    const dirp = h.heap.alloc(16);
    state.dirs.set(dirp, { entries: h.vfs.listDir(name), ent: h.heap.alloc(0x120) });
    return dirp;
  });
  on('libc', 273, () => {                            // P.I.P.S dirent: ino, reclen, type, namlen, name
    const st = state.dirs.get(a(0));
    if (!st || !st.entries.length) return 0;
    const name = st.entries.shift().slice(0, 255);
    const b = new Uint8Array(8 + name.length + 1);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 1, true); dv.setUint16(4, 0x120, true); b[6] = 8; b[7] = name.length;
    for (let i = 0; i < name.length; i++) b[8 + i] = name.charCodeAt(i);
    put(st.ent, b);
    return st.ent;
  });
  on('libc', 58, () => { state.dirs.delete(a(0)); return 0; });

  // --- libdl: game DLLs load natively; ngifileaccess is HLE
  on('libdl', 3, () => {
    const name = h.cstr(a(0));
    const mod = h.m.loadDll(name);
    const handle = 0x7D000000 + 0x100 * (state.dl.size + 1);
    state.dl.set(handle, { name, mod });
    h.log(`[dl] dlopen(${name}) -> ${mod ? 'native' : 'hle'}`);
    return handle;
  });
  on('libdl', 4, () => {
    const { name, mod } = state.dl.get(a(0)) || { name: '?', mod: null };
    const sym = h.cstr(a(1));
    const fn = mod ? (/^\d+$/.test(sym) ? mod.export(+sym) : 0) : h.ngi.dlsym(name, sym);
    if (!fn) h.fail(`dlsym(${name}, ${sym}) not handled`);
    return fn;
  });
  on('libdl', 1, () => 0);
}
