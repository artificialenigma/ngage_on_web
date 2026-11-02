// High-level emulation core: trap dispatch, guest heap, strings, guest callbacks, clock.
// Mirrors port/proto/hle.py; libc/euser/ngi stubs live in their own modules.

import { HEAP_BASE, HEAP_SIZE, TRAMP_BASE, STACK_TOP } from './machine.js';
import { registerLibc } from './libc.js';
import { registerEuser } from './euser.js';
import { NGI } from './ngi.js';

export const SYN_BASE = 0xF0080000;     // synthetic traps: guest-callable JS functions
export const RET_TRAP = 0xF00FFFF0;     // boot's return address
export const M32 = 0xFFFFFFFF;

export const s32 = (v) => v | 0;
export const u32 = (v) => v >>> 0;

class Heap {
  // First-fit allocator with a free list, 8-byte granularity (same policy as the prototype).
  constructor(core, base, size) {
    this.core = core;
    this.base = base;
    this.end = base + size;
    this.top = base;
    this.free = [];
    this.sizes = new Map();
  }

  alloc(n) {
    n = Math.max(8, (n + 7) & ~7);
    for (let i = 0; i < this.free.length; i++) {
      let [a, s] = this.free[i];
      if (s >= n) {
        if (s - n >= 16) this.free[i] = [a + n, s - n];
        else { this.free.splice(i, 1); n = s; }
        this.sizes.set(a, n);
        this.core.write(a, new Uint8Array(n));
        return a;
      }
    }
    const a = this.top;
    if (a + n > this.end) throw new Error('guest heap exhausted');
    this.top += n;
    this.sizes.set(a, n);
    return a;
  }

  release(a) {
    if (this.sizes.has(a)) {
      this.free.push([a, this.sizes.get(a)]);
      this.sizes.delete(a);
    }
  }

  realloc(a, n) {
    if (!a) return this.alloc(n);
    const old = this.sizes.get(a) || 0;
    if (n <= old) return a;
    const b = this.alloc(n);
    this.core.write(b, this.core.read(a, old));
    this.release(a);
    return b;
  }
}

export class HLE {
  // EPOCH: fixed start (2026-11-01 03:00 UTC) — reproducible, and a value that passes the DRM
  // self-check (see worklog.md). The clock then only moves with emulated work and idle waits.
  static EPOCH = 1793412000;

  constructor(machine, opts) {
    this.m = machine;
    this.core = machine.core;
    this.opts = opts;
    this.names = opts.names;            // { euser: { '196': 'CTrapCleanup::New()' }, ... }
    this.syn = [];
    this.calls = new Map();
    this.impl = new Map();
    this.cbStack = [];
    this.yieldRequested = false;
    this.logLines = [];
    this.heap = new Heap(this.core, HEAP_BASE, HEAP_SIZE);
    this.ngi = new NGI(this);
    registerLibc(this);
    registerEuser(this);
    this.ngi.register();
  }

  log(s) {
    if (this.opts.log) this.opts.log(s);
  }

  // --- plumbing ---------------------------------------------------------------------------
  name(dll, ordinal) {
    return (this.names[dll] && this.names[dll][ordinal]) || `${dll}#${ordinal}`;
  }

  isDataImport(dll, ordinal) {
    const n = (this.names[dll] && this.names[dll][ordinal]) || '';
    return n.startsWith('_ZTV') || n.startsWith('_ZTI') || n.startsWith('vtable for') || n.startsWith('typeinfo for');
  }

  on(dll, ordinal, fn) {
    this.impl.set(`${dll}:${ordinal}`, fn);
  }

  syntheticFn(label, fn) {
    const addr = (SYN_BASE + 8 * this.syn.length) >>> 0;
    this.syn.push([label, fn]);
    return addr;
  }

  synthetic(address) {
    if (address === RET_TRAP) return;
    const [label, fn] = this.syn[(address - SYN_BASE) / 8];
    this.setRet(fn());
  }

  setRet(ret) {
    if (ret === undefined || ret === null) return;
    if (Array.isArray(ret)) {
      this.core.setReg(0, ret[0] >>> 0);
      this.core.setReg(1, ret[1] >>> 0);
    } else {
      this.core.setReg(0, ret >>> 0);
    }
  }

  call(dll, ordinal) {
    const key = `${dll}:${ordinal}`;
    this.calls.set(key, (this.calls.get(key) || 0) + 1);
    this.ngi.nowUs += 20;               // code takes time to run: keep the virtual clock moving
    const fn = this.impl.get(key);
    if (!fn) {
      const args = [0, 1, 2, 3].map((i) => '0x' + this.a(i).toString(16));
      this.fail(`unimplemented ${this.name(dll, ordinal)} args=${args} lr=0x${this.core.reg(14).toString(16)}`);
      return undefined;
    }
    return fn();
  }

  fail(why) {
    this.m.stopReason = `${why} (lr=0x${this.core.reg(14).toString(16)})`;
    this.core.stop();
  }

  exit(code) { this.fail(`guest exit(${code})`); }

  wallClock() { return HLE.EPOCH + Math.floor(this.ngi.nowUs / 1e6); }

  // --- guest callbacks (see hle.py run_guest_calls) ---------------------------------------
  runGuestCalls(calls, ret) {
    if (!calls.length) return ret;
    this.cbStack.push({ lr: this.core.reg(14), sp: this.core.reg(13), queue: calls.slice(), ret });
    this.nextGuestCall();
    return undefined;
  }

  nextGuestCall() {
    const core = this.core;
    const fr = this.cbStack[this.cbStack.length - 1];
    if (!fr.queue.length) {
      this.cbStack.pop();
      core.setReg(13, fr.sp);
      core.setReg(14, fr.lr);
      this.setRet(fr.ret);
      return;
    }
    const [addr, args] = fr.queue.shift();
    let sp = fr.sp;
    const stack = args.slice(4);
    if (stack.length) {
      sp = (sp - 4 * stack.length) & ~7;
      stack.forEach((v, i) => core.w32(sp + 4 * i, v >>> 0));
    }
    core.setReg(13, sp >>> 0);
    args.slice(0, 4).forEach((v, i) => core.setReg(i, v >>> 0));
    core.setReg(12, addr >>> 0);
    core.setReg(14, TRAMP_BASE);
  }

  // --- memory helpers ---------------------------------------------------------------------
  a(i) { return this.m.arg(i); }
  r32(a) { return this.core.r32(a); }
  w32(a, v) { this.core.w32(a, v >>> 0); }

  cstrBytes(a, limit = 1 << 20) {
    const out = [];
    for (let off = 0; a && out.length < limit; off += 64) {
      const chunk = this.core.read(a + off, 64);
      const z = chunk.indexOf(0);
      if (z >= 0) { out.push(...chunk.subarray(0, z)); break; }
      out.push(...chunk);
    }
    return Uint8Array.from(out);
  }

  cstr(a) { return a ? String.fromCharCode(...this.cstrBytes(a)) : ''; }

  wstr(a, limit = 4096) {
    let s = '';
    for (let n = 0; a && n < limit; n++) {
      const c = this.core.r32(a + 2 * n) & 0xFFFF;   // r32 is safe: strings sit inside mapped pages
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  putWide(addr, s, terminate = true) {
    const b = new Uint8Array(2 * s.length + (terminate ? 2 : 0));
    for (let i = 0; i < s.length; i++) { b[2 * i] = s.charCodeAt(i) & 0xFF; b[2 * i + 1] = s.charCodeAt(i) >> 8; }
    this.core.write(addr, b);
  }

  putAscii(addr, s, terminate = true) {
    const b = new Uint8Array(s.length + (terminate ? 1 : 0));
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xFF;
    this.core.write(addr, b);
  }

  allocWide(s) { const p = this.heap.alloc(2 * s.length + 2); this.putWide(p, s); return p; }
  allocAscii(s) { const p = this.heap.alloc(s.length + 1); this.putAscii(p, s); return p; }

  // --- boot -------------------------------------------------------------------------------
  /** The E32 entry stub branches (`bls`, entry+0x18) to the thread startup. */
  startupTarget() {
    const img = this.m.exe.image, stub = img.h.code_base + img.h.entry + 0x18;
    const insn = new DataView(img.code.buffer, img.code.byteOffset).getUint32(stub - img.h.code_base, true);
    if ((insn & 0x0F000000) !== 0x0A000000) throw new Error(`unexpected E32 startup stub 0x${insn.toString(16)}`);
    return (stub + 8 + (((insn & 0xFFFFFF) << 8) >> 6)) >>> 0;
  }

  /** Set up the Symbian EXE startup call: r0 = aNotFirst = 0, r1 = SStdEpocThreadCreateInfo*. */
  boot() {
    const cont = this.syntheticFn('callback-continue', () => { this.nextGuestCall(); return undefined; });
    // TRAMP: blx r12 ; ldr pc, [pc, #-4] ; .word CONT
    this.core.write(TRAMP_BASE, new Uint8Array(new Uint32Array([0xE12FFF3C, 0xE51FF004, cont]).buffer));
    const info = this.heap.alloc(0x40);
    this.core.setReg(13, STACK_TOP);
    this.core.setReg(0, 0);
    this.core.setReg(1, info);
    this.core.setReg(14, RET_TRAP);
    this.core.setReg(15, this.startupTarget());
  }
}
