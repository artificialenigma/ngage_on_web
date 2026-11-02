// Thin wrapper over the wasm ARM core (port/core). Registers: 0-15 = r0-r15, 16 = CPSR.

export const STOP = { UNTIL: 0, TRAP: 1, FAULT: 2, LIMIT: 3, UNDEFINED: 4, REQUESTED: 5, COMPILE: 6 };

export class Core {
  static async fromBytes(bytes) {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new Core(instance.exports);
  }

  constructor(x) {
    this.x = x;
    x.core_reset();
  }

  // wasm memory can grow, so never cache the view
  get heap() {
    return new Uint8Array(this.x.memory.buffer);
  }

  setTrapBase(a) { this.x.core_set_trap_base(a); }
  map(addr, size) { this.x.core_mem_map(addr >>> 0, size >>> 0); }

  write(addr, bytes) {
    if (!bytes.length) return;
    const p = this.x.core_scratch(bytes.length) >>> 0;
    this.heap.set(bytes, p);
    if (this.x.core_mem_write(addr >>> 0, bytes.length)) {
      throw new Error(`write fault at 0x${(this.x.core_fault_addr() >>> 0).toString(16)}`);
    }
  }

  read(addr, n) {
    if (!n) return new Uint8Array(0);
    if (this.x.core_mem_read(addr >>> 0, n)) {
      throw new Error(`read fault at 0x${(this.x.core_fault_addr() >>> 0).toString(16)}`);
    }
    const p = this.x.core_scratch(n) >>> 0;
    return this.heap.slice(p, p + n);
  }

  r32(a) { return this.x.core_r32(a >>> 0) >>> 0; }
  w32(a, v) { this.x.core_w32(a >>> 0, v >>> 0); }
  r8(a) { return this.read(a, 1)[0]; }
  reg(i) { return this.x.core_reg_read(i) >>> 0; }
  setReg(i, v) { this.x.core_reg_write(i, v >>> 0); }
  run(until, limit) { return this.x.core_run(until >>> 0, limit >>> 0); }
  trapReturn() { this.x.core_trap_return(); }
  stop() { this.x.core_stop(); }
  faultAddr() { return this.x.core_fault_addr() >>> 0; }
  undefinedInsn() { return this.x.core_undefined_insn() >>> 0; }
  executed() { return (this.x.core_executed_lo() >>> 0) + (this.x.core_executed_hi() >>> 0) * 2 ** 32; }

  // --- JIT: the core translates hot ARM blocks into wasm modules; we instantiate them against the
  // core's memory and put each function in the core's table, where the core calls it directly.
  enableJit() {
    if (!this.x.core_jit_enable || !this.x.__indirect_function_table) return false;
    const x = this.x;
    this.jitImports = { env: { memory: x.memory, ld8: x.core_jit_ld8, ld16: x.core_jit_ld16, ld32: x.core_jit_ld32,
      st8: x.core_jit_st8, st16: x.core_jit_st16, st32: x.core_jit_st32 } };
    x.core_jit_enable(1);
    return true;
  }

  installBlock() {
    const x = this.x, pc = x.core_jit_req_pc() >>> 0;
    const p = x.core_jit_req_ptr() >>> 0, n = x.core_jit_req_len() >>> 0;
    try {
      const inst = new WebAssembly.Instance(new WebAssembly.Module(this.heap.slice(p, p + n)), this.jitImports);
      const table = x.__indirect_function_table;
      const idx = table.grow(1);
      table.set(idx, inst.exports.f);
      x.core_jit_install(pc, idx);
    } catch (err) {
      x.core_jit_reject(pc);                 // keep interpreting this block
      if (!this.jitErrors) this.jitErrors = [];
      if (this.jitErrors.length < 5) this.jitErrors.push(`0x${pc.toString(16)}: ${err.message}`);
    }
  }

  jitBlocks() { return this.x.core_jit_blocks ? this.x.core_jit_blocks() >>> 0 : 0; }

  /** Decode a PNG/JPEG held in guest memory -> {width, height} or null (pixels via copyImage). */
  decodeImage(addr, len) {
    if (!this.x.core_image_decode(addr >>> 0, len >>> 0)) return null;
    return { width: this.x.core_image_width() >>> 0, height: this.x.core_image_height() >>> 0 };
  }

  copyImage(dst) { return !!this.x.core_image_copy(dst >>> 0); }
}
