//! ARMv5TE (+ Thumb-1) user-mode interpreter.
//!
//! Semantics follow what Unicorn (ARMv7 model) does for the same code, because the Python
//! prototype was validated on Unicorn: unaligned word accesses are plain little-endian reads,
//! data-processing writes to PC interwork (bit 0 selects Thumb), as do LDR/LDM/POP of PC.

use crate::mem::{Fault, Memory};

pub const PC: usize = 15;
pub const LR: usize = 14;
pub const SP: usize = 13;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    Until = 0,     // reached the `until` address
    Trap = 1,      // PC entered the trap region (host handles the call)
    Fault = 2,     // invalid memory access
    Limit = 3,     // instruction budget used up
    Undefined = 4, // unimplemented / undefined instruction
    Requested = 5, // host asked to stop
    Compile = 6,   // a hot block was translated; host must install it (see jit.rs)
}

pub const JIT_SLOTS: usize = 1 << 16;
pub const JIT_REJECT: u32 = u32::MAX;
const JIT_THRESHOLD: u16 = 16;

pub struct Cpu {
    pub r: [u32; 16],
    pub n: bool,
    pub z: bool,
    pub c: bool,
    pub v: bool,
    pub t: bool,
    pub mem: Memory,
    pub trap_base: u32,
    pub fault: Fault,
    pub undefined_insn: u32,
    pub stop_requested: bool,
    pub faulted: bool,
    pub executed: u64,
    pub thumb_executed: u64,
    pub hook_pc: u32,
    pub hook_op: u32,
    pub prof_every: u64,
    pub prof: Vec<u32>,
    fetch_page: u32,
    fetch_off: usize,
    // JIT (only active in the wasm build, enabled by the host)
    pub jit_enabled: bool,
    pub jit_tbl: u32,
    pub jit_data: u32,
    pub jit_tags: Vec<u32>,
    pub jit_fns: Vec<u32>,
    pub jit_hot: Vec<u16>,
    pub jit_req: Vec<u8>,
    pub jit_req_pc: u32,
    pub jit_blocks: u32,
}



#[inline(always)]
fn add_with_carry(a: u32, b: u32, carry: bool) -> (u32, bool, bool) {
    let sum = a as u64 + b as u64 + carry as u64;
    let res = sum as u32;
    let c = sum > 0xFFFF_FFFF;
    let v = ((a ^ res) & (b ^ res)) >> 31 != 0;
    (res, c, v)
}

impl Cpu {
    pub fn new() -> Self {
        Cpu {
            r: [0; 16],
            n: false,
            z: false,
            c: false,
            v: false,
            t: false,
            mem: Memory::new(),
            trap_base: 0xF000_0000,
            fault: Fault { addr: 0, write: false },
            undefined_insn: 0,
            stop_requested: false,
            faulted: false,
            executed: 0,
            thumb_executed: 0,
            hook_pc: 1,
            hook_op: 0,
            prof_every: 0,
            prof: Vec::new(),
            fetch_page: 1,
            fetch_off: 0,
            jit_enabled: false,
            jit_tbl: 0,
            jit_data: 0,
            jit_tags: Vec::new(),
            jit_fns: Vec::new(),
            jit_hot: Vec::new(),
            jit_req: Vec::new(),
            jit_req_pc: 0,
            jit_blocks: 0,
        }
    }

    pub fn cpsr(&self) -> u32 {
        ((self.n as u32) << 31) | ((self.z as u32) << 30) | ((self.c as u32) << 29) | ((self.v as u32) << 28)
            | ((self.t as u32) << 5) | 0x10
    }

    pub fn set_cpsr(&mut self, v: u32) {
        self.n = v >> 31 & 1 != 0;
        self.z = v >> 30 & 1 != 0;
        self.c = v >> 29 & 1 != 0;
        self.v = v >> 28 & 1 != 0;
        self.t = v >> 5 & 1 != 0;
    }

    /// Branch with interworking: bit 0 selects Thumb.
    #[inline(always)]
    pub fn bx(&mut self, target: u32) {
        self.t = target & 1 != 0;
        self.r[PC] = target & if self.t { !1 } else { !3 };
    }

    #[inline(always)]
    fn cond(&self, c: u32) -> bool {
        match c {
            0x0 => self.z,
            0x1 => !self.z,
            0x2 => self.c,
            0x3 => !self.c,
            0x4 => self.n,
            0x5 => !self.n,
            0x6 => self.v,
            0x7 => !self.v,
            0x8 => self.c && !self.z,
            0x9 => !self.c || self.z,
            0xA => self.n == self.v,
            0xB => self.n != self.v,
            0xC => !self.z && self.n == self.v,
            0xD => self.z || self.n != self.v,
            _ => true,
        }
    }

    #[inline(always)]
    fn set_nz(&mut self, v: u32) {
        self.n = v >> 31 != 0;
        self.z = v == 0;
    }

    /// Run until `until` is reached, PC enters the trap region, a fault, or `limit` instructions.
    /// (Stop requests arrive between runs, from the host's trap handling, so they are only checked
    /// on entry.)
    pub fn run(&mut self, until: u32, limit: u64) -> Stop {
        if self.stop_requested {
            self.stop_requested = false;
            return Stop::Requested;
        }
        let end = if limit == 0 { u64::MAX } else { self.executed + limit };
        let mut check = true;
        loop {
            let pc = self.r[PC];
            // Straight-line ARM code cannot reach the trap region, `until` or the hook address, and
            // every loop branches, so these checks only run after a non-sequential PC change.
            if check {
                if pc == until {
                    return Stop::Until;
                }
                if pc >= self.trap_base {
                    return Stop::Trap;
                }
                if self.executed >= end {
                    return Stop::Limit;
                }
                if pc == self.hook_pc {
                    self.executed += 1;
                    if let Err(f) = crate::native::run(self, self.hook_op) {
                        self.fault = f;
                        self.r[PC] = pc;
                        return Stop::Fault;
                    }
                    continue;
                }
                if self.jit_enabled && !self.t {
                    let slot = ((pc >> 2) as usize) & (JIT_SLOTS - 1);
                    if self.jit_tags[slot] == pc {
                        let f = self.jit_fns[slot];
                        if f != JIT_REJECT {
                            self.call_jit(f);
                            if self.faulted {
                                self.faulted = false;
                                return Stop::Fault;
                            }
                            continue; // check stays true: the block always ends with a jump
                        }
                    } else {
                        self.jit_hot[slot] += 1;
                        if self.jit_hot[slot] >= JIT_THRESHOLD {
                            self.jit_hot[slot] = 0;
                            match crate::jit::compile(self, pc) {
                                Some((code, _)) => {
                                    self.jit_req = code;
                                    self.jit_req_pc = pc;
                                    return Stop::Compile;
                                }
                                None => {
                                    self.jit_tags[slot] = pc;
                                    self.jit_fns[slot] = JIT_REJECT;
                                }
                            }
                        }
                    }
                }
            }
            if self.prof_every != 0 && self.executed % self.prof_every == 0 {
                self.prof.push(pc);
            }
            let ok = if self.t { self.thumb_executed += 1; self.step_thumb() } else { self.step_arm() };
            self.executed += 1;
            if self.faulted {
                self.faulted = false;
                self.r[PC] = pc;
                return Stop::Fault;
            }
            if !ok {
                self.r[PC] = pc;
                return Stop::Undefined;
            }
            check = self.t || self.r[PC] != pc.wrapping_add(4);
        }
    }

    pub fn jit_enable(&mut self, on: bool) {
        self.jit_enabled = on;
        if on && self.jit_tags.is_empty() {
            self.jit_tags = vec![1; JIT_SLOTS]; // 1 never matches an aligned ARM pc
            self.jit_fns = vec![JIT_REJECT; JIT_SLOTS];
            self.jit_hot = vec![0; JIT_SLOTS];
        }
    }

    pub fn jit_install(&mut self, pc: u32, f: u32) {
        let slot = ((pc >> 2) as usize) & (JIT_SLOTS - 1);
        self.jit_tags[slot] = pc;
        self.jit_fns[slot] = f;
        if f != JIT_REJECT {
            self.jit_blocks += 1;
        }
    }

    /// Call a compiled block (a function-table index in the wasm build).
    #[cfg(target_arch = "wasm32")]
    fn call_jit(&mut self, f: u32) {
        self.jit_tbl = self.mem.table_ptr() as u32;
        self.jit_data = self.mem.data.as_ptr() as u32;
        let func: extern "C" fn(*mut Cpu) -> u32 = unsafe { std::mem::transmute(f as usize) };
        func(self as *mut Cpu);
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn call_jit(&mut self, _f: u32) {
        unreachable!("the JIT only runs in the wasm build");
    }

    // helpers called from JIT code for slow-path memory access
    pub fn jit_ld(&mut self, size: u32, a: u32) -> u32 {
        match size { 1 => self.ld8(a), 2 => self.ld16(a), _ => self.ld32(a) }
    }

    pub fn jit_st(&mut self, size: u32, a: u32, v: u32) {
        match size { 1 => self.st8(a, v), 2 => self.st16(a, v), _ => self.st32(a, v) }
    }

    /// Instruction fetch through a one-page cache (code is fetched far more often than it changes
    /// page; data writes to code pages are still seen because the cache holds an offset, not a copy).
    #[inline(always)]
    fn fetch32(&mut self, pc: u32) -> u32 {
        if pc & 0xFFFF_F000 == self.fetch_page && pc & 0xFFF <= 0xFFC {
            let o = self.fetch_off + (pc & 0xFFF) as usize;
            return unsafe { (self.mem.data.as_ptr().add(o) as *const u32).read_unaligned() };
        }
        self.refill_fetch(pc);
        self.ld32(pc)
    }

    #[inline(always)]
    fn fetch16(&mut self, pc: u32) -> u32 {
        if pc & 0xFFFF_F000 == self.fetch_page && pc & 0xFFF <= 0xFFE {
            let o = self.fetch_off + (pc & 0xFFF) as usize;
            return unsafe { (self.mem.data.as_ptr().add(o) as *const u16).read_unaligned() } as u32;
        }
        self.refill_fetch(pc);
        self.ld16(pc)
    }

    #[cold]
    fn refill_fetch(&mut self, pc: u32) {
        let page = pc & 0xFFFF_F000;
        if let Some(o) = self.mem.page_offset(page) {
            self.fetch_page = page;
            self.fetch_off = o;
        } else {
            self.fetch_page = 1; // never matches an aligned page
        }
    }


    // Memory access with a sticky fault flag instead of Result (wasm returns Result through
    // memory, which made every load/store slower). The run loop checks `faulted` after each step.
    #[inline(always)]
    fn ld8(&mut self, a: u32) -> u32 {
        match self.mem.r8(a) { Ok(v) => v, Err(f) => self.fail(f) }
    }

    #[inline(always)]
    fn ld16(&mut self, a: u32) -> u32 {
        match self.mem.r16(a) { Ok(v) => v, Err(f) => self.fail(f) }
    }

    #[inline(always)]
    fn ld32(&mut self, a: u32) -> u32 {
        match self.mem.r32(a) { Ok(v) => v, Err(f) => self.fail(f) }
    }

    #[inline(always)]
    fn st8(&mut self, a: u32, v: u32) {
        if let Err(f) = self.mem.w8(a, v) { self.fail(f); }
    }

    #[inline(always)]
    fn st16(&mut self, a: u32, v: u32) {
        if let Err(f) = self.mem.w16(a, v) { self.fail(f); }
    }

    #[inline(always)]
    fn st32(&mut self, a: u32, v: u32) {
        if let Err(f) = self.mem.w32(a, v) { self.fail(f); }
    }

    #[cold]
    fn fail(&mut self, f: Fault) -> u32 {
        if !self.faulted {
            self.fault = f;
            self.faulted = true;
        }
        0
    }

    // ------------------------------------------------------------------ ARM
    #[inline(always)]
    fn reg_arm(&self, n: usize, pc: u32) -> u32 {
        if n == PC { pc.wrapping_add(8) } else { self.r[n] }
    }

    /// Barrel shifter for a register operand. Returns (value, carry).
    #[inline(always)]
    fn shift_reg(&self, insn: u32, pc: u32) -> (u32, bool) {
        let rm = (insn & 0xF) as usize;
        if insn & 0xFF0 == 0 {
            return (self.reg_arm(rm, pc), self.c); // plain register: by far the most common form
        }
        let typ = (insn >> 5) & 3;
        if insn & 0x10 == 0 {
            let v = self.reg_arm(rm, pc);
            let amt = (insn >> 7) & 0x1F;
            match typ {
                0 => {
                    if amt == 0 { (v, self.c) } else { (v << amt, (v >> (32 - amt)) & 1 != 0) }
                }
                1 => {
                    if amt == 0 { (0, v >> 31 != 0) } else { (v >> amt, (v >> (amt - 1)) & 1 != 0) }
                }
                2 => {
                    if amt == 0 {
                        let s = ((v as i32) >> 31) as u32;
                        (s, v >> 31 != 0)
                    } else {
                        (((v as i32) >> amt) as u32, (v >> (amt - 1)) & 1 != 0)
                    }
                }
                _ => {
                    if amt == 0 {
                        (((self.c as u32) << 31) | (v >> 1), v & 1 != 0) // RRX
                    } else {
                        (v.rotate_right(amt), (v >> (amt - 1)) & 1 != 0)
                    }
                }
            }
        } else {
            // register-specified shift: PC reads as +12
            let v = if rm == PC { pc.wrapping_add(12) } else { self.r[rm] };
            let rs = ((insn >> 8) & 0xF) as usize;
            let amt = (if rs == PC { pc.wrapping_add(12) } else { self.r[rs] }) & 0xFF;
            self.shift_by(typ, v, amt)
        }
    }

    #[inline(always)]
    fn shift_by(&self, typ: u32, v: u32, amt: u32) -> (u32, bool) {
        if amt == 0 {
            return (v, self.c);
        }
        match typ {
            0 => {
                if amt < 32 { (v << amt, (v >> (32 - amt)) & 1 != 0) } else if amt == 32 { (0, v & 1 != 0) } else { (0, false) }
            }
            1 => {
                if amt < 32 { (v >> amt, (v >> (amt - 1)) & 1 != 0) } else if amt == 32 { (0, v >> 31 != 0) } else { (0, false) }
            }
            2 => {
                if amt < 32 {
                    (((v as i32) >> amt) as u32, (v >> (amt - 1)) & 1 != 0)
                } else {
                    (((v as i32) >> 31) as u32, v >> 31 != 0)
                }
            }
            _ => {
                let a = amt & 31;
                if a == 0 { (v, v >> 31 != 0) } else { (v.rotate_right(a), (v >> (a - 1)) & 1 != 0) }
            }
        }
    }

    /// Write a data-processing / load result to Rd (PC writes interwork, as on ARMv7).
    #[inline(always)]
    fn write_rd(&mut self, rd: usize, v: u32) {
        if rd == PC { self.bx(v) } else { self.r[rd] = v }
    }

    fn step_arm(&mut self) -> bool {
        let pc = self.r[PC];
        let insn = self.fetch32(pc);
        self.r[PC] = pc.wrapping_add(4);
        let cond = insn >> 28;
        if cond == 0xF {
            return self.arm_unconditional(insn, pc);
        }
        if cond != 0xE && !self.cond(cond) {
            return true;
        }
        match (insn >> 25) & 7 {
            0 => self.arm_class0(insn, pc),
            1 => {
                if insn & 0x0FB0_F000 == 0x0320_F000 {
                    let rot = ((insn >> 8) & 0xF) * 2;
                    let v = (insn & 0xFF).rotate_right(rot);
                    self.msr(insn, v);
                    return true;
                }
                let rot = ((insn >> 8) & 0xF) * 2;
                let v = (insn & 0xFF).rotate_right(rot);
                let c = if rot == 0 { self.c } else { v >> 31 != 0 };
                self.data_processing(insn, v, c, pc);
                true
            }
            2 => {
                let off = insn & 0xFFF;
                self.load_store(insn, off, pc)
            }
            3 => {
                if insn & 0x10 != 0 {
                    if let Some(op) = crate::native::decode_udf(insn) {
                        self.r[PC] = pc;
                        return match crate::native::run(self, op) {
                            Ok(done) => done,
                            Err(f) => { self.fail(f); true }
                        };
                    }
                    self.undefined_insn = insn;
                    return false; // media instructions: not used by the game
                }
                let (off, _) = self.shift_reg(insn, pc);
                self.load_store(insn, off, pc)
            }
            4 => self.block_transfer(insn, pc),
            5 => {
                let off = (((insn & 0x00FF_FFFF) << 8) as i32 >> 6) as u32;
                if insn & 0x0100_0000 != 0 {
                    self.r[LR] = pc.wrapping_add(4);
                }
                self.r[PC] = pc.wrapping_add(8).wrapping_add(off);
                true
            }
            _ => {
                self.undefined_insn = insn;
                false // coprocessor / SWI
            }
        }
    }

    fn arm_unconditional(&mut self, insn: u32, pc: u32) -> bool {
        if insn & 0x0E00_0000 == 0x0A00_0000 {
            // BLX imm
            let off = (((insn & 0x00FF_FFFF) << 8) as i32 >> 6) as u32;
            let h = (insn >> 24) & 1;
            self.r[LR] = pc.wrapping_add(4);
            self.t = true;
            self.r[PC] = pc.wrapping_add(8).wrapping_add(off).wrapping_add(h << 1);
            return true;
        }
        if insn & 0x0D70_F000 == 0x0550_F000 {
            return true; // PLD
        }
        self.undefined_insn = insn;
        false
    }

    fn msr(&mut self, insn: u32, v: u32) {
        if insn & (1 << 22) != 0 {
            return; // SPSR: no exception modes here
        }
        if insn & (1 << 19) != 0 {
            self.n = v >> 31 & 1 != 0;
            self.z = v >> 30 & 1 != 0;
            self.c = v >> 29 & 1 != 0;
            self.v = v >> 28 & 1 != 0;
        }
    }

    fn arm_class0(&mut self, insn: u32, pc: u32) -> bool {
        // Fast path for the common case, data processing with a register operand. Everything else
        // in this class has bits 7 and 4 both set (multiplies, extra loads/stores, SWP) or sits in
        // the op=10xx/S=0 "misc" space (BX, CLZ, MRS/MSR, SMULxy).
        if insn & 0x90 != 0x90 && insn & 0x0190_0000 != 0x0100_0000 {
            let (v, c) = self.shift_reg(insn, pc);
            self.data_processing(insn, v, c, pc);
            return true;
        }
        // BX / BLX register
        if insn & 0x0FFF_FFD0 == 0x012F_FF10 {
            let target = self.reg_arm((insn & 0xF) as usize, pc);
            if insn & 0x20 != 0 {
                self.r[LR] = pc.wrapping_add(4);
            }
            self.bx(target);
            return true;
        }
        if insn & 0x0FFF_0FF0 == 0x016F_0F10 {
            let rd = ((insn >> 12) & 0xF) as usize;
            self.r[rd] = self.r[(insn & 0xF) as usize].leading_zeros();
            return true;
        }
        if insn & 0x0FC0_00F0 == 0x0000_0090 {
            // MUL / MLA
            let rd = ((insn >> 16) & 0xF) as usize;
            let mut v = self.r[(insn & 0xF) as usize].wrapping_mul(self.r[((insn >> 8) & 0xF) as usize]);
            if insn & (1 << 21) != 0 {
                v = v.wrapping_add(self.r[((insn >> 12) & 0xF) as usize]);
            }
            self.r[rd] = v;
            if insn & (1 << 20) != 0 {
                self.set_nz(v);
            }
            return true;
        }
        if insn & 0x0F80_00F0 == 0x0080_0090 {
            // UMULL / UMLAL / SMULL / SMLAL
            let hi = ((insn >> 16) & 0xF) as usize;
            let lo = ((insn >> 12) & 0xF) as usize;
            let a = self.r[(insn & 0xF) as usize];
            let b = self.r[((insn >> 8) & 0xF) as usize];
            let mut v: u64 = if insn & (1 << 22) != 0 {
                ((a as i32 as i64) * (b as i32 as i64)) as u64
            } else {
                (a as u64) * (b as u64)
            };
            if insn & (1 << 21) != 0 {
                v = v.wrapping_add(((self.r[hi] as u64) << 32) | self.r[lo] as u64);
            }
            self.r[lo] = v as u32;
            self.r[hi] = (v >> 32) as u32;
            if insn & (1 << 20) != 0 {
                self.n = v >> 63 != 0;
                self.z = v == 0;
            }
            return true;
        }
        if insn & 0x0FB0_0FF0 == 0x0100_0090 {
            // SWP / SWPB
            let rn = self.r[((insn >> 16) & 0xF) as usize];
            let rm = self.r[(insn & 0xF) as usize];
            let rd = ((insn >> 12) & 0xF) as usize;
            if insn & (1 << 22) != 0 {
                let old = self.ld8(rn);
                self.st8(rn, rm);
                self.r[rd] = old;
            } else {
                let old = self.ld32(rn);
                self.st32(rn, rm);
                self.r[rd] = old;
            }
            return true;
        }
        if insn & 0x0E00_0090 == 0x0000_0090 && insn & 0x60 != 0 {
            return self.extra_load_store(insn, pc);
        }
        if insn & 0x0F90_0090 == 0x0100_0080 {
            return self.signed_multiply(insn);
        }
        if insn & 0x0FBF_0FFF == 0x010F_0000 {
            self.r[((insn >> 12) & 0xF) as usize] = self.cpsr();
            return true;
        }
        if insn & 0x0FB0_FFF0 == 0x0120_F000 {
            let v = self.r[(insn & 0xF) as usize];
            self.msr(insn, v);
            return true;
        }
        if insn & 0x0190_0000 == 0x0100_0000 {
            // remaining misc space (TST..CMN without S): undefined here
            self.undefined_insn = insn;
            return false;
        }
        let (v, c) = self.shift_reg(insn, pc);
        self.data_processing(insn, v, c, pc);
        true
    }

    fn signed_multiply(&mut self, insn: u32) -> bool {
        let rd = ((insn >> 16) & 0xF) as usize;
        let rn = ((insn >> 12) & 0xF) as usize;
        let rs = self.r[((insn >> 8) & 0xF) as usize];
        let rm = self.r[(insn & 0xF) as usize];
        let x = if insn & 0x20 != 0 { (rm >> 16) as i16 } else { rm as i16 } as i32;
        let y = if insn & 0x40 != 0 { (rs >> 16) as i16 } else { rs as i16 } as i32;
        match (insn >> 21) & 3 {
            0 => self.r[rd] = (x.wrapping_mul(y)).wrapping_add(self.r[rn] as i32) as u32, // SMLAxy
            1 => {
                let w = ((rm as i32 as i64) * (y as i64)) >> 16;
                self.r[rd] = if insn & 0x20 != 0 {
                    w as u32 // SMULWy
                } else {
                    (w as i32).wrapping_add(self.r[rn] as i32) as u32 // SMLAWy
                };
            }
            2 => {
                // SMLALxy: RdHi = rd, RdLo = rn
                let acc = ((self.r[rd] as u64) << 32 | self.r[rn] as u64) as i64;
                let v = acc.wrapping_add((x as i64) * (y as i64)) as u64;
                self.r[rn] = v as u32;
                self.r[rd] = (v >> 32) as u32;
            }
            _ => self.r[rd] = x.wrapping_mul(y) as u32, // SMULxy
        }
        true
    }

    #[inline(always)]
    fn data_processing(&mut self, insn: u32, op2: u32, shc: bool, pc: u32) {
        let s = insn & (1 << 20) != 0;
        let rn = self.reg_arm(((insn >> 16) & 0xF) as usize, pc);
        let rd = ((insn >> 12) & 0xF) as usize;
        // S with Rd = PC is an exception return in privileged modes: no flags in user code.
        let flags = s && rd != PC;
        match (insn >> 21) & 0xF {
            0x0 => self.dp_logic(rd, rn & op2, flags, shc),
            0x1 => self.dp_logic(rd, rn ^ op2, flags, shc),
            0x2 => self.dp_arith(rd, rn, !op2, true, flags),
            0x3 => self.dp_arith(rd, op2, !rn, true, flags),
            0x4 => self.dp_arith(rd, rn, op2, false, flags),
            0x5 => { let c = self.c; self.dp_arith(rd, rn, op2, c, flags) }
            0x6 => { let c = self.c; self.dp_arith(rd, rn, !op2, c, flags) }
            0x7 => { let c = self.c; self.dp_arith(rd, op2, !rn, c, flags) }
            0x8 => self.test_logic(rn & op2, shc),
            0x9 => self.test_logic(rn ^ op2, shc),
            0xA => self.test_arith(rn, !op2, true),
            0xB => self.test_arith(rn, op2, false),
            0xC => self.dp_logic(rd, rn | op2, flags, shc),
            0xD => self.dp_logic(rd, op2, flags, shc),
            0xE => self.dp_logic(rd, rn & !op2, flags, shc),
            _ => self.dp_logic(rd, !op2, flags, shc),
        }
    }

    #[inline(always)]
    fn dp_logic(&mut self, rd: usize, res: u32, flags: bool, shc: bool) {
        if flags {
            self.set_nz(res);
            self.c = shc;
        }
        self.write_rd(rd, res);
    }

    #[inline(always)]
    fn dp_arith(&mut self, rd: usize, a: u32, b: u32, carry: bool, flags: bool) {
        let (res, c, v) = add_with_carry(a, b, carry);
        if flags {
            self.set_nz(res);
            self.c = c;
            self.v = v;
        }
        self.write_rd(rd, res);
    }

    #[inline(always)]
    fn test_logic(&mut self, res: u32, shc: bool) {
        self.set_nz(res);
        self.c = shc;
    }

    #[inline(always)]
    fn test_arith(&mut self, a: u32, b: u32, carry: bool) {
        let (res, c, v) = add_with_carry(a, b, carry);
        self.set_nz(res);
        self.c = c;
        self.v = v;
    }

    fn load_store(&mut self, insn: u32, off: u32, pc: u32) -> bool {
        let p = insn & (1 << 24) != 0;
        let u = insn & (1 << 23) != 0;
        let b = insn & (1 << 22) != 0;
        let w = insn & (1 << 21) != 0;
        let l = insn & (1 << 20) != 0;
        let rn = ((insn >> 16) & 0xF) as usize;
        let rd = ((insn >> 12) & 0xF) as usize;
        let base = self.reg_arm(rn, pc);
        let offset_addr = if u { base.wrapping_add(off) } else { base.wrapping_sub(off) };
        let addr = if p { offset_addr } else { base };
        if l {
            let v = if b { self.ld8(addr) } else { self.ld32(addr) };
            if !p || w {
                self.r[rn] = offset_addr;
            }
            self.write_rd(rd, v);
        } else {
            let v = if rd == PC { pc.wrapping_add(8) } else { self.r[rd] };
            if b { self.st8(addr, v) } else { self.st32(addr, v) }
            if !p || w {
                self.r[rn] = offset_addr;
            }
        }
        true
    }

    fn extra_load_store(&mut self, insn: u32, pc: u32) -> bool {
        let p = insn & (1 << 24) != 0;
        let u = insn & (1 << 23) != 0;
        let i = insn & (1 << 22) != 0;
        let w = insn & (1 << 21) != 0;
        let l = insn & (1 << 20) != 0;
        let rn = ((insn >> 16) & 0xF) as usize;
        let rd = ((insn >> 12) & 0xF) as usize;
        let off = if i { ((insn >> 4) & 0xF0) | (insn & 0xF) } else { self.r[(insn & 0xF) as usize] };
        let base = self.reg_arm(rn, pc);
        let offset_addr = if u { base.wrapping_add(off) } else { base.wrapping_sub(off) };
        let addr = if p { offset_addr } else { base };
        let sh = (insn >> 5) & 3;
        let wb = !p || w;
        match (l, sh) {
            (true, 1) => {
                let v = self.ld16(addr);
                if wb { self.r[rn] = offset_addr; }
                self.write_rd(rd, v);
            }
            (true, 2) => {
                let v = self.ld8(addr) as u8 as i8 as i32 as u32;
                if wb { self.r[rn] = offset_addr; }
                self.write_rd(rd, v);
            }
            (true, 3) => {
                let v = self.ld16(addr) as u16 as i16 as i32 as u32;
                if wb { self.r[rn] = offset_addr; }
                self.write_rd(rd, v);
            }
            (false, 1) => {
                let v = if rd == PC { pc.wrapping_add(8) } else { self.r[rd] };
                self.st16(addr, v);
                if wb { self.r[rn] = offset_addr; }
            }
            (false, 2) => {
                // LDRD
                let a = self.ld32(addr);
                let b = self.ld32(addr.wrapping_add(4));
                if wb { self.r[rn] = offset_addr; }
                self.r[rd] = a;
                self.r[rd + 1] = b;
            }
            (false, 3) => {
                // STRD
                self.st32(addr, self.r[rd]);
                self.st32(addr.wrapping_add(4), self.r[rd + 1]);
                if wb { self.r[rn] = offset_addr; }
            }
            _ => {
                self.undefined_insn = insn;
                return false;
            }
        }
        true
    }

    fn block_transfer(&mut self, insn: u32, _pc: u32) -> bool {
        let p = insn & (1 << 24) != 0;
        let u = insn & (1 << 23) != 0;
        let w = insn & (1 << 21) != 0;
        let l = insn & (1 << 20) != 0;
        let rn = ((insn >> 16) & 0xF) as usize;
        let list = insn & 0xFFFF;
        let count = list.count_ones();
        let base = self.r[rn];
        let start = match (p, u) {
            (false, true) => base,                                        // IA
            (true, true) => base.wrapping_add(4),                         // IB
            (false, false) => base.wrapping_sub(4 * count).wrapping_add(4), // DA
            (true, false) => base.wrapping_sub(4 * count),                // DB
        };
        let new_base = if u { base.wrapping_add(4 * count) } else { base.wrapping_sub(4 * count) };
        let mut addr = start;
        if l {
            let mut vals = [0u32; 16];
            for i in 0..16 {
                if list & (1 << i) != 0 {
                    vals[i] = self.ld32(addr);
                    addr = addr.wrapping_add(4);
                }
            }
            if w {
                self.r[rn] = new_base;
            }
            for i in 0..15 {
                if list & (1 << i) != 0 {
                    self.r[i] = vals[i];
                }
            }
            if list & 0x8000 != 0 {
                self.bx(vals[15]);
            }
        } else {
            for i in 0..16 {
                if list & (1 << i) != 0 {
                    let v = if i == PC { self.r[PC].wrapping_add(4) } else { self.r[i] };
                    self.st32(addr, v);
                    addr = addr.wrapping_add(4);
                }
            }
            if w {
                self.r[rn] = new_base;
            }
        }
        true
    }

    // ------------------------------------------------------------------ Thumb
    fn step_thumb(&mut self) -> bool {
        let pc = self.r[PC];
        let h = self.fetch16(pc);
        self.r[PC] = pc.wrapping_add(2);
        let pc4 = pc.wrapping_add(4);
        match h >> 11 {
            0x00..=0x02 => {
                // LSL/LSR/ASR imm
                let rd = (h & 7) as usize;
                let v = self.r[((h >> 3) & 7) as usize];
                let amt = (h >> 6) & 0x1F;
                let (res, c) = match h >> 11 {
                    0 => if amt == 0 { (v, self.c) } else { (v << amt, (v >> (32 - amt)) & 1 != 0) },
                    1 => if amt == 0 { (0, v >> 31 != 0) } else { (v >> amt, (v >> (amt - 1)) & 1 != 0) },
                    _ => {
                        if amt == 0 {
                            (((v as i32) >> 31) as u32, v >> 31 != 0)
                        } else {
                            (((v as i32) >> amt) as u32, (v >> (amt - 1)) & 1 != 0)
                        }
                    }
                };
                self.r[rd] = res;
                self.set_nz(res);
                self.c = c;
            }
            0x03 => {
                // ADD/SUB reg or imm3
                let rd = (h & 7) as usize;
                let rn = self.r[((h >> 3) & 7) as usize];
                let operand = if h & 0x400 != 0 { (h >> 6) & 7 } else { self.r[((h >> 6) & 7) as usize] };
                let (res, c, v) = if h & 0x200 != 0 {
                    add_with_carry(rn, !operand, true)
                } else {
                    add_with_carry(rn, operand, false)
                };
                self.r[rd] = res;
                self.set_nz(res);
                self.c = c;
                self.v = v;
            }
            0x04..=0x07 => {
                // MOV/CMP/ADD/SUB imm8
                let rd = ((h >> 8) & 7) as usize;
                let imm = h & 0xFF;
                match (h >> 11) & 3 {
                    0 => {
                        self.r[rd] = imm;
                        self.set_nz(imm);
                    }
                    1 => {
                        let (res, c, v) = add_with_carry(self.r[rd], !imm, true);
                        self.set_nz(res);
                        self.c = c;
                        self.v = v;
                    }
                    2 => {
                        let (res, c, v) = add_with_carry(self.r[rd], imm, false);
                        self.r[rd] = res;
                        self.set_nz(res);
                        self.c = c;
                        self.v = v;
                    }
                    _ => {
                        let (res, c, v) = add_with_carry(self.r[rd], !imm, true);
                        self.r[rd] = res;
                        self.set_nz(res);
                        self.c = c;
                        self.v = v;
                    }
                }
            }
            0x08 => {
                if h & 0x400 == 0 {
                    self.thumb_alu(h);
                } else {
                    // hi register ops / BX / BLX
                    let rd = ((h & 7) | ((h >> 4) & 8)) as usize;
                    let rm = ((h >> 3) & 0xF) as usize;
                    let vm = if rm == PC { pc4 } else { self.r[rm] };
                    match (h >> 8) & 3 {
                        0 => {
                            let vd = if rd == PC { pc4 } else { self.r[rd] };
                            let res = vd.wrapping_add(vm);
                            if rd == PC { self.r[PC] = res & !1 } else { self.r[rd] = res }
                        }
                        1 => {
                            let vd = if rd == PC { pc4 } else { self.r[rd] };
                            let (res, c, v) = add_with_carry(vd, !vm, true);
                            self.set_nz(res);
                            self.c = c;
                            self.v = v;
                        }
                        2 => {
                            if rd == PC { self.r[PC] = vm & !1 } else { self.r[rd] = vm }
                        }
                        _ => {
                            if h & 0x80 != 0 {
                                self.r[LR] = pc.wrapping_add(2) | 1;
                            }
                            self.bx(vm);
                        }
                    }
                }
            }
            0x09 => {
                // LDR Rd, [PC, #imm]
                let rd = ((h >> 8) & 7) as usize;
                let addr = (pc4 & !3).wrapping_add((h & 0xFF) << 2);
                self.r[rd] = self.ld32(addr);
            }
            0x0A | 0x0B => {
                // load/store register offset
                let rd = (h & 7) as usize;
                let addr = self.r[((h >> 3) & 7) as usize].wrapping_add(self.r[((h >> 6) & 7) as usize]);
                match (h >> 9) & 7 {
                    0 => self.st32(addr, self.r[rd]),
                    1 => self.st16(addr, self.r[rd]),
                    2 => self.st8(addr, self.r[rd]),
                    3 => self.r[rd] = self.ld8(addr) as u8 as i8 as i32 as u32,
                    4 => self.r[rd] = self.ld32(addr),
                    5 => self.r[rd] = self.ld16(addr),
                    6 => self.r[rd] = self.ld8(addr),
                    _ => self.r[rd] = self.ld16(addr) as u16 as i16 as i32 as u32,
                }
            }
            0x0C..=0x0F => {
                // LDR/STR (B) imm5
                let rd = (h & 7) as usize;
                let base = self.r[((h >> 3) & 7) as usize];
                let imm = (h >> 6) & 0x1F;
                let byte = h & 0x1000 != 0;
                let addr = base.wrapping_add(if byte { imm } else { imm << 2 });
                match (byte, h & 0x800 != 0) {
                    (false, false) => self.st32(addr, self.r[rd]),
                    (false, true) => self.r[rd] = self.ld32(addr),
                    (true, false) => self.st8(addr, self.r[rd]),
                    (true, true) => self.r[rd] = self.ld8(addr),
                }
            }
            0x10 | 0x11 => {
                // LDRH/STRH imm5
                let rd = (h & 7) as usize;
                let addr = self.r[((h >> 3) & 7) as usize].wrapping_add(((h >> 6) & 0x1F) << 1);
                if h & 0x800 != 0 { self.r[rd] = self.ld16(addr) } else { self.st16(addr, self.r[rd]) }
            }
            0x12 | 0x13 => {
                // SP-relative
                let rd = ((h >> 8) & 7) as usize;
                let addr = self.r[SP].wrapping_add((h & 0xFF) << 2);
                if h & 0x800 != 0 { self.r[rd] = self.ld32(addr) } else { self.st32(addr, self.r[rd]) }
            }
            0x14 | 0x15 => {
                // ADD Rd, PC/SP, #imm
                let rd = ((h >> 8) & 7) as usize;
                let base = if h & 0x800 != 0 { self.r[SP] } else { pc4 & !3 };
                self.r[rd] = base.wrapping_add((h & 0xFF) << 2);
            }
            0x16 | 0x17 => return self.thumb_misc(h),
            0x18 | 0x19 => {
                // STMIA / LDMIA
                let rn = ((h >> 8) & 7) as usize;
                let list = h & 0xFF;
                let mut addr = self.r[rn];
                if h & 0x800 != 0 {
                    let mut vals = [0u32; 8];
                    for i in 0..8 {
                        if list & (1 << i) != 0 {
                            vals[i] = self.ld32(addr);
                            addr = addr.wrapping_add(4);
                        }
                    }
                    if list & (1 << rn) == 0 {
                        self.r[rn] = addr;
                    }
                    for i in 0..8 {
                        if list & (1 << i) != 0 {
                            self.r[i] = vals[i];
                        }
                    }
                } else {
                    for i in 0..8 {
                        if list & (1 << i) != 0 {
                            self.st32(addr, self.r[i]);
                            addr = addr.wrapping_add(4);
                        }
                    }
                    self.r[rn] = addr;
                }
            }
            0x1A | 0x1B => {
                // conditional branch / SWI
                let cond = (h >> 8) & 0xF;
                if cond >= 0xE {
                    self.undefined_insn = h;
                    return false;
                }
                if self.cond(cond) {
                    let off = ((h & 0xFF) as u8 as i8 as i32) << 1;
                    self.r[PC] = pc4.wrapping_add(off as u32);
                }
            }
            0x1C => {
                let off = (((h & 0x7FF) << 21) as i32 >> 20) as u32;
                self.r[PC] = pc4.wrapping_add(off);
            }
            0x1D => {
                // BLX suffix (to ARM)
                let target = self.r[LR].wrapping_add((h & 0x7FF) << 1) & !3;
                self.r[LR] = pc.wrapping_add(2) | 1;
                self.t = false;
                self.r[PC] = target;
            }
            0x1E => {
                // BL/BLX prefix
                let off = (((h & 0x7FF) << 21) as i32 >> 9) as u32;
                self.r[LR] = pc4.wrapping_add(off);
            }
            _ => {
                // BL suffix
                let target = self.r[LR].wrapping_add((h & 0x7FF) << 1);
                self.r[LR] = pc.wrapping_add(2) | 1;
                self.r[PC] = target;
            }
        }
        true
    }

    fn thumb_alu(&mut self, h: u32) {
        let rd = (h & 7) as usize;
        let rm = self.r[((h >> 3) & 7) as usize];
        let vd = self.r[rd];
        let op = (h >> 6) & 0xF;
        let res = match op {
            0x0 => vd & rm,
            0x1 => vd ^ rm,
            0x2 | 0x3 | 0x4 | 0x7 => {
                let typ = match op { 0x2 => 0, 0x3 => 1, 0x4 => 2, _ => 3 };
                let (r, c) = self.shift_by(typ, vd, rm & 0xFF);
                self.c = c;
                r
            }
            0x5 => {
                let (r, c, v) = add_with_carry(vd, rm, self.c);
                self.c = c;
                self.v = v;
                r
            }
            0x6 => {
                let (r, c, v) = add_with_carry(vd, !rm, self.c);
                self.c = c;
                self.v = v;
                r
            }
            0x8 => {
                let r = vd & rm;
                self.set_nz(r);
                return;
            }
            0x9 => {
                let (r, c, v) = add_with_carry(0, !rm, true);
                self.c = c;
                self.v = v;
                r
            }
            0xA => {
                let (r, c, v) = add_with_carry(vd, !rm, true);
                self.set_nz(r);
                self.c = c;
                self.v = v;
                return;
            }
            0xB => {
                let (r, c, v) = add_with_carry(vd, rm, false);
                self.set_nz(r);
                self.c = c;
                self.v = v;
                return;
            }
            0xC => vd | rm,
            0xD => vd.wrapping_mul(rm),
            0xE => vd & !rm,
            _ => !rm,
        };
        self.r[rd] = res;
        self.set_nz(res);
    }

    fn thumb_misc(&mut self, h: u32) -> bool {
        if h & 0xFF00 == 0xB000 {
            let imm = (h & 0x7F) << 2;
            self.r[SP] = if h & 0x80 != 0 { self.r[SP].wrapping_sub(imm) } else { self.r[SP].wrapping_add(imm) };
            return true;
        }
        if h & 0xF600 == 0xB400 {
            let list = h & 0xFF;
            let extra = h & 0x100 != 0;
            let n = list.count_ones() + extra as u32;
            if h & 0x800 == 0 {
                // PUSH
                let mut addr = self.r[SP].wrapping_sub(4 * n);
                self.r[SP] = addr;
                for i in 0..8 {
                    if list & (1 << i) != 0 {
                        self.st32(addr, self.r[i]);
                        addr = addr.wrapping_add(4);
                    }
                }
                if extra {
                    self.st32(addr, self.r[LR]);
                }
            } else {
                // POP
                let mut addr = self.r[SP];
                let mut vals = [0u32; 9];
                for i in 0..8 {
                    if list & (1 << i) != 0 {
                        vals[i] = self.ld32(addr);
                        addr = addr.wrapping_add(4);
                    }
                }
                if extra {
                    vals[8] = self.ld32(addr);
                    addr = addr.wrapping_add(4);
                }
                self.r[SP] = addr;
                for i in 0..8 {
                    if list & (1 << i) != 0 {
                        self.r[i] = vals[i];
                    }
                }
                if extra {
                    self.bx(vals[8]);
                }
            }
            return true;
        }
        self.undefined_insn = h;
        false
    }
}
