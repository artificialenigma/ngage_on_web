// Loads E32 images (uncompressed; see port/tools/prepare_web.py), relocates them, binds imports
// to trap addresses / native modules / guestlib, and runs the core, dispatching traps to the HLE.
// Mirrors port/proto/loader.py.

import { STOP } from './core.js';

export const CODE_BASE = 0x8000, DATA_BASE = 0x400000;
export const HEAP_BASE = 0x10000000, HEAP_SIZE = 0x04000000;
export const STACK_BASE = 0x20000000, STACK_SIZE = 0x00100000;
export const STACK_TOP = STACK_BASE + STACK_SIZE - 0x100;
export const DIMP_BASE = 0x30000000, DIMP_SIZE = 0x00100000;
export const GLIB_BASE = 0x30800000;
export const TRAMP_BASE = 0x30900000;
export const MODULE_BASE = 0x50000000, MODULE_SLOT = 0x01000000;
export const CHUNK_BASE = 0x60000000, CHUNK_SIZE = 0x01000000;   // smaller than the prototype: lazily used
export const TRAP_BASE = 0xF0000000, TRAP_SIZE = 0x00100000;

const page = (x) => (x + 0xFFF) & ~0xFFF;

// native op ids, see port/core/src/native.rs
const NATIVE_OPS = { __aeabi_uidivmod: 1, __aeabi_idivmod: 2, __aeabi_memcpy: 3, __aeabi_memcpy4: 3,
  __aeabi_memmove: 4, __aeabi_memmove4: 4, __aeabi_memset: 5, __aeabi_memclr: 6, __aeabi_memclr4: 6 };
const COTD_UID = 0x2000AFBC, BLIT565_ADDR = 0xefec;   // COTD routine: RGB565 frame -> XRGB8888 back buffer

export function dllBasename(name) {
  return name.split('{')[0].split('[')[0].split('.')[0].toLowerCase();
}

export class Image {
  constructor(name, bytes) {
    this.name = name;
    this.b = bytes;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.dv = dv;
    const keys = ['header_crc', 'majmin', 'comp_type', 'petran', 'msb', 'lsb', 'flags', 'code_size', 'data_size',
      'heap_min', 'heap_max', 'stack', 'bss', 'entry', 'code_base', 'data_base', 'dll_ref', 'export_off',
      'export_cnt', 'text_size', 'code_off', 'data_off', 'import_off', 'creloc', 'dreloc', 'priocpu'];
    this.h = {};
    keys.forEach((k, i) => { this.h[k] = dv.getUint32(20 + 4 * i, true); });
    if (this.h.comp_type !== 0) throw new Error(`${name}: compressed image (run prepare_web.py)`);
    if ((this.h.flags & 0xF0000000) >>> 0 !== 0x10000000) throw new Error(`${name}: expected ELF imports`);
    this.code = bytes.slice(this.h.code_off, this.h.code_off + this.h.code_size);
    this.data = this.h.data_size ? bytes.slice(this.h.data_off, this.h.data_off + this.h.data_size) : new Uint8Array(0);
    this.imports = this.parseImports();
  }

  u32(off) { return this.dv.getUint32(off, true); }

  cstr(off) {
    let e = off;
    while (this.b[e]) e++;
    return String.fromCharCode(...this.b.subarray(off, e));
  }

  parseImports() {
    const off = this.h.import_off, out = [];
    const cdv = new DataView(this.code.buffer, this.code.byteOffset, this.code.byteLength);
    let p = off + 4;
    for (let k = 0; k < this.h.dll_ref; k++) {
      const nameOff = this.u32(p), n = this.u32(p + 4);
      const sites = [];
      for (let i = 0; i < n; i++) {
        const o = this.u32(p + 8 + 4 * i);
        const w = cdv.getUint32(o, true);
        sites.push([o, w & 0xFFFF, w >>> 16]);
      }
      out.push([dllBasename(this.cstr(off + nameOff)), sites]);
      p += 8 + 4 * n;
    }
    return out;
  }

  relocs(which) {
    const off = which === 'code' ? this.h.creloc : this.h.dreloc;
    if (!off) return [];
    const size = this.u32(off), out = [];
    let p = off + 8;
    const end = off + 8 + size;
    while (p < end) {
      const pageOff = this.u32(p), block = this.u32(p + 4);
      for (let k = 0; k < (block - 8) / 2; k++) {
        const e = this.dv.getUint16(p + 8 + 2 * k, true);
        if (e) out.push([pageOff + (e & 0xFFF), e & 0xF000]);
      }
      p += block;
    }
    return out;
  }
}

export class Module {
  constructor(image, codeAddr, dataAddr) {
    this.image = image;
    this.codeAddr = codeAddr;
    this.dataAddr = dataAddr;
    this.name = dllBasename(image.name);
    this.codeDelta = (codeAddr - image.h.code_base) >>> 0;
    this.dataDelta = (dataAddr - image.h.data_base) >>> 0;
  }

  export(ordinal) {
    const h = this.image.h;
    if (ordinal < 1 || ordinal > h.export_cnt) return 0;
    const v = this.image.u32(h.export_off + 4 * (ordinal - 1));
    return (v + this.codeDelta) >>> 0;
  }
}

export class Machine {
  constructor(core, game, files, guestlib, hleFactory) {
    this.core = core;
    this.game = game;
    this.files = files;                    // { 'sys/COTD.exe': Uint8Array, ... }
    // every DLL the game ships runs natively (its libc shim and DRM file-manager factory)
    this.nativeDlls = new Set(game.sys.filter((n) => n.toLowerCase().endsWith('.dll')).map(dllBasename));
    core.setTrapBase(TRAP_BASE);
    core.map(HEAP_BASE, HEAP_SIZE);
    core.map(STACK_BASE, STACK_SIZE);
    core.map(DIMP_BASE, DIMP_SIZE);
    core.map(CHUNK_BASE, CHUNK_SIZE);
    core.map(TRAP_BASE, TRAP_SIZE);
    core.map(TRAMP_BASE, 0x1000);
    core.map(GLIB_BASE, page(guestlib.bin.length));
    core.write(GLIB_BASE, guestlib.bin);
    this.glib = Object.fromEntries(Object.entries(guestlib.syms).map(([k, v]) => [k, GLIB_BASE + v]));
    // Hot helpers run as native Rust (port/core/src/native.rs); the ARM versions stay as fallback.
    for (const [name, op] of Object.entries(NATIVE_OPS)) if (this.glib[name]) core.x.core_set_native(this.glib[name], op);
    if (game.uid === COTD_UID) core.x.core_set_hook(BLIT565_ADDR, 7);

    this.traps = [];
    this.trapOf = new Map();
    this.dimpOf = new Map();
    this.dimpNext = DIMP_BASE;
    this.modules = new Map();
    this.chunkNext = CHUNK_BASE;
    this.stopReason = null;
    this.hle = hleFactory(this);
    this.exe = this.mapImage(new Image(game.exe, files['sys/' + game.exe]), CODE_BASE, DATA_BASE);
  }

  loadDll(name) {
    const base = dllBasename(name);
    if (this.modules.has(base)) return this.modules.get(base);
    if (!this.nativeDlls.has(base)) return null;
    const key = Object.keys(this.files).find((k) => k.toLowerCase() === `sys/${base}.dll`);
    if (!key) return null;
    const img = new Image(key.slice(4), this.files[key]);
    for (const [dep] of img.imports) {
      if (this.nativeDlls.has(dep) && !this.modules.has(dep)) this.loadDll(dep);
    }
    const others = [...this.modules.values()].filter((m) => m !== this.exe).length;
    const slot = (MODULE_BASE + MODULE_SLOT * others) >>> 0;
    const mod = this.mapImage(img, slot, (slot + MODULE_SLOT / 2) >>> 0);
    this.hle.log(`[ld] loaded ${img.name} code=0x${slot.toString(16)}`);
    return mod;
  }

  mapImage(img, codeAddr, dataAddr) {
    const core = this.core, h = img.h;
    const mod = new Module(img, codeAddr, dataAddr);
    core.map(codeAddr, page(h.code_size));
    core.write(codeAddr, img.code);
    const dsize = h.data_size + h.bss;
    if (dsize) {
      core.map(dataAddr, page(dsize));
      if (img.data.length) core.write(dataAddr, img.data);
    }
    if (mod.codeDelta || mod.dataDelta) this.relocate(mod);
    this.modules.set(mod.name, mod);
    this.bindImports(mod);
    return mod;
  }

  relocate(mod) {
    const img = mod.image, core = this.core;
    const lo = img.h.code_base, hi = img.h.code_base + img.h.code_size;
    for (const [which, base] of [['code', mod.codeAddr], ['data', mod.dataAddr]]) {
      for (let [off, typ] of img.relocs(which)) {
        const addr = (base + off) >>> 0;
        const v = core.r32(addr);
        if (typ === 0x3000) typ = (v >= lo && v < hi) ? 0x1000 : 0x2000;
        core.w32(addr, (v + (typ === 0x1000 ? mod.codeDelta : mod.dataDelta)) >>> 0);
      }
    }
  }

  bindImports(mod) {
    for (const [dll, sites] of mod.image.imports) {
      for (const [codeOff, ordinal, addend] of sites) {
        const key = `${dll}:${ordinal}`;
        const target = this.modules.get(dll);
        const native = this.glib[this.hle.name(dll, ordinal)];
        let addr;
        if (target && target !== mod) addr = target.export(ordinal) + addend;
        else if (addend || this.hle.isDataImport(dll, ordinal)) addr = this.dataImport(key) + addend;
        else if (native) addr = native;
        else addr = this.trap(dll, ordinal);
        this.core.w32(mod.codeAddr + codeOff, addr >>> 0);
      }
    }
  }

  trap(dll, ordinal) {
    const key = `${dll}:${ordinal}`;
    if (!this.trapOf.has(key)) {
      this.trapOf.set(key, (TRAP_BASE + 8 * this.traps.length) >>> 0);
      this.traps.push([dll, ordinal]);
    }
    return this.trapOf.get(key);
  }

  dataImport(key) {
    if (!this.dimpOf.has(key)) {
      this.dimpOf.set(key, this.dimpNext);
      this.dimpNext += 0x100;
    }
    return this.dimpOf.get(key);
  }

  allocChunk(size) {
    const addr = this.chunkNext;
    this.chunkNext = (this.chunkNext + page(Math.max(size, 0x1000)) + 0x10000) >>> 0;
    if (this.chunkNext > CHUNK_BASE + CHUNK_SIZE) throw new Error('chunk area exhausted');
    return addr;
  }

  arg(i) {
    if (i < 4) return this.core.reg(i);
    return this.core.r32(this.core.reg(13) + 4 * (i - 4));
  }

  /**
   * Run guest code until `until`, a stop request or a fault. Traps are dispatched to the HLE;
   * returns 'until' | 'yield' | 'stopped'.
   */
  run(until, limit = 0) {
    const core = this.core, hle = this.hle;
    for (;;) {
      const rc = core.run(until, limit);
      if (rc === STOP.UNTIL) return 'until';
      if (rc === STOP.LIMIT || rc === STOP.REQUESTED) return 'yield';
      if (rc === STOP.COMPILE) { core.installBlock(); continue; }
      const pc = core.reg(15);
      if (rc === STOP.TRAP) {
        const idx = (pc - TRAP_BASE) / 8;
        if (idx < this.traps.length) {
          const [dll, ordinal] = this.traps[idx];
          hle.setRet(hle.call(dll, ordinal));
        } else {
          hle.synthetic(pc);
        }
        if (this.stopReason) return 'stopped';
        core.trapReturn();
        if (hle.yieldRequested) {
          hle.yieldRequested = false;
          return 'yield';
        }
        continue;
      }
      if (rc === STOP.FAULT) {
        this.stopReason = `invalid memory access at 0x${core.faultAddr().toString(16)} pc=0x${pc.toString(16)}`;
      } else {
        this.stopReason = `undefined instruction 0x${core.undefinedInsn().toString(16)} at pc=0x${pc.toString(16)}`;
      }
      return 'stopped';
    }
  }
}
