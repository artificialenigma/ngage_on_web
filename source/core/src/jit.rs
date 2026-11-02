//! ARM basic-block translator: ARM (ARMv5TE subset) -> one small WebAssembly module per block.
//!
//! The host (JS) instantiates each module against the core's memory and adds its function to the
//! core's function table; `Cpu::run` then calls blocks directly. A block is straight-line code up
//! to its first control-flow instruction; a branch back to the block's own start becomes a wasm
//! `loop` (bounded by BUDGET iterations), which keeps hot inner loops inside compiled code.
//! Anything not handled here ends the block early and the interpreter takes over, so coverage only
//! affects speed, never behaviour. Semantics mirror `cpu.rs` exactly (validated frame-for-frame).
//!
//! Generated function: (func (param $cpu i32) (result i32)). Registers and NZCV live in locals,
//! loaded on entry and written back on exit; PC/T/executed are stored on exit.

use std::mem::offset_of;

use crate::cpu::Cpu;

pub const MAX_INSNS: usize = 96;
const MAX_BODY_BYTES: usize = 3000;
const BUDGET: i32 = 4096; // self-loop iterations per call

// locals (local 0 = $cpu)
const R0: u32 = 1; // r0..r15 -> 1..16
const LN: u32 = 17;
const LZ: u32 = 18;
const LC: u32 = 19;
const LV: u32 = 20;
const TBL: u32 = 21;
const DATA: u32 = 22;
const A: u32 = 23; // address
const T1: u32 = 24;
const T2: u32 = 25;
const T3: u32 = 26;
const CY: u32 = 27; // shifter carry out
const ITER: u32 = 28;
const NPC: u32 = 29;
const NT: u32 = 30;
const ST: u32 = 31; // start address for LDM/STM
const W: u32 = 32; // i64
const N_I32_LOCALS: u32 = 31; // locals 1..=31
const N_I64_LOCALS: u32 = 1;

// imported functions
const F_LD8: u32 = 0;
const F_LD16: u32 = 1;
const F_LD32: u32 = 2;
const F_ST8: u32 = 3;
const F_ST16: u32 = 4;
const F_ST32: u32 = 5;
const F_SELF: u32 = 6;

#[derive(Default)]
struct E {
    b: Vec<u8>,
}

impl E {
    fn op(&mut self, x: u8) -> &mut Self {
        self.b.push(x);
        self
    }
    fn uleb(&mut self, mut v: u64) -> &mut Self {
        loop {
            let byte = (v & 0x7F) as u8;
            v >>= 7;
            if v == 0 {
                self.b.push(byte);
                return self;
            }
            self.b.push(byte | 0x80);
        }
    }
    fn sleb(&mut self, mut v: i64) -> &mut Self {
        loop {
            let byte = (v & 0x7F) as u8;
            v >>= 7;
            let done = (v == 0 && byte & 0x40 == 0) || (v == -1 && byte & 0x40 != 0);
            self.b.push(if done { byte } else { byte | 0x80 });
            if done {
                return self;
            }
        }
    }
    fn i32c(&mut self, v: u32) -> &mut Self {
        self.op(0x41).sleb(v as i32 as i64)
    }
    fn i64c(&mut self, v: i64) -> &mut Self {
        self.op(0x42).sleb(v)
    }
    fn get(&mut self, l: u32) -> &mut Self {
        self.op(0x20).uleb(l as u64)
    }
    fn set(&mut self, l: u32) -> &mut Self {
        self.op(0x21).uleb(l as u64)
    }
    fn tee(&mut self, l: u32) -> &mut Self {
        self.op(0x22).uleb(l as u64)
    }
    fn mem(&mut self, opc: u8, align: u32, off: u32) -> &mut Self {
        self.op(opc).uleb(align as u64).uleb(off as u64)
    }
    fn call(&mut self, f: u32) -> &mut Self {
        self.op(0x10).uleb(f as u64)
    }
    fn if_(&mut self) -> &mut Self {
        self.op(0x04).op(0x40)
    }
    fn if_i32(&mut self) -> &mut Self {
        self.op(0x04).op(0x7F)
    }
    fn else_(&mut self) -> &mut Self {
        self.op(0x05)
    }
    fn end(&mut self) -> &mut Self {
        self.op(0x0B)
    }
}

// i32 ops
const ADD: u8 = 0x6A;
const SUB: u8 = 0x6B;
const MUL: u8 = 0x6C;
const AND: u8 = 0x71;
const OR: u8 = 0x72;
const XOR: u8 = 0x73;
const SHL: u8 = 0x74;
const SHR_S: u8 = 0x75;
const SHR_U: u8 = 0x76;
const ROTR: u8 = 0x78;
const EQZ: u8 = 0x45;
const EQ: u8 = 0x46;
const NE: u8 = 0x47;
const LT_U: u8 = 0x49;
const LE_U: u8 = 0x4D;
const CLZ: u8 = 0x67;
const SELECT: u8 = 0x1B;
// i64 ops
const I64_ADD: u8 = 0x7C;
const I64_MUL: u8 = 0x7E;
const I64_SHL: u8 = 0x86;
const I64_SHR_S: u8 = 0x87;
const I64_SHR_U: u8 = 0x88;
const I64_EQZ: u8 = 0x50;
const WRAP: u8 = 0xA7;
const EXT_S: u8 = 0xAC;
const EXT_U: u8 = 0xAD;

#[derive(Clone, Copy)]
enum Cin {
    Zero,
    One,
    Carry,
}

struct Ctx<'a> {
    e: E,
    cpu: &'a Cpu,
    entry: u32,
    written: u16, // registers written (store back on exit)
    flags_written: bool,
}

/// Translate the block at `pc`. Returns (module bytes, instruction count) or None if the very
/// first instruction is not supported (the slot is then marked as interpreter-only).
pub fn compile(cpu: &Cpu, pc: u32) -> Option<(Vec<u8>, usize)> {
    let mut cx = Ctx { e: E::default(), cpu, entry: pc, written: 0, flags_written: false };
    let body = cx.body(pc)?;
    Some((module(&body.0, body.1, cx.written, cx.flags_written), body.1))
}

impl<'a> Ctx<'a> {
    fn reg(&mut self, r: u32, pc: u32) {
        if r == 15 {
            self.e.i32c(pc.wrapping_add(8));
        } else {
            self.e.get(R0 + r);
        }
    }

    fn set_reg(&mut self, r: u32) {
        self.e.set(R0 + r);
        self.written |= 1 << r;
    }

    fn flag_nz_from(&mut self, l: u32) {
        self.e.get(l).i32c(31).op(SHR_U).set(LN);
        self.e.get(l).op(EQZ).set(LZ);
        self.flags_written = true;
    }

    /// Push the ARM condition `c` (not AL) as an i32 truth value.
    fn cond(&mut self, c: u32) {
        let e = &mut self.e;
        match c {
            0x0 => { e.get(LZ); }
            0x1 => { e.get(LZ).op(EQZ); }
            0x2 => { e.get(LC); }
            0x3 => { e.get(LC).op(EQZ); }
            0x4 => { e.get(LN); }
            0x5 => { e.get(LN).op(EQZ); }
            0x6 => { e.get(LV); }
            0x7 => { e.get(LV).op(EQZ); }
            0x8 => { e.get(LC).get(LZ).op(EQZ).op(AND); }
            0x9 => { e.get(LC).op(EQZ).get(LZ).op(OR); }
            0xA => { e.get(LN).get(LV).op(EQ); }
            0xB => { e.get(LN).get(LV).op(NE); }
            0xC => { e.get(LZ).op(EQZ).get(LN).get(LV).op(EQ).op(AND); }
            _ => { e.get(LZ).get(LN).get(LV).op(NE).op(OR); }
        }
    }

    /// Branch with interworking into NPC/NT from the value on the stack.
    fn bx_from_stack(&mut self) {
        let e = &mut self.e;
        e.tee(T3).i32c(1).op(AND).set(NT);
        e.get(T3).i32c(!1).i32c(!3).get(NT).op(SELECT).op(AND).set(NPC);
    }

    fn jump(&mut self, target: u32, thumb: bool) {
        self.e.i32c(target).set(NPC).i32c(thumb as u32).set(NT);
    }

    // ---- memory -----------------------------------------------------------------------------
    /// Fast-path load from address in A: inline page lookup, helper call for slow cases.
    fn load(&mut self, size: u32) {
        let (opc, helper, lim) = match size {
            1 => (0x2D, F_LD8, 0xFFF),
            2 => (0x2F, F_LD16, 0xFFE),
            _ => (0x28, F_LD32, 0xFFC),
        };
        let e = &mut self.e;
        e.get(A).i32c(12).op(SHR_U).i32c(2).op(SHL).get(TBL).op(ADD).mem(0x28, 2, 0).set(T3);
        e.get(T3).i32c(u32::MAX).op(NE).get(A).i32c(0xFFF).op(AND).i32c(lim).op(LE_U).op(AND);
        e.if_i32();
        e.get(DATA).get(T3).op(ADD).get(A).i32c(0xFFF).op(AND).op(ADD).mem(opc, 0, 0);
        e.else_();
        e.get(A).call(helper);
        e.end();
    }

    /// Store value in T2 to address in A.
    fn store(&mut self, size: u32) {
        let (opc, helper, lim) = match size {
            1 => (0x3A, F_ST8, 0xFFF),
            2 => (0x3B, F_ST16, 0xFFE),
            _ => (0x36, F_ST32, 0xFFC),
        };
        let e = &mut self.e;
        e.get(A).i32c(12).op(SHR_U).i32c(2).op(SHL).get(TBL).op(ADD).mem(0x28, 2, 0).set(T3);
        e.get(T3).i32c(u32::MAX).op(NE).get(A).i32c(0xFFF).op(AND).i32c(lim).op(LE_U).op(AND);
        e.if_();
        e.get(DATA).get(T3).op(ADD).get(A).i32c(0xFFF).op(AND).op(ADD).get(T2).mem(opc, 0, 0);
        e.else_();
        e.get(A).get(T2).call(helper);
        e.end();
    }

    // ---- operand 2 ------------------------------------------------------------------------------
    /// Push the shifter operand; if `carry`, also leave the shifter carry-out in CY.
    fn operand2(&mut self, insn: u32, pc: u32, carry: bool) -> bool {
        if insn & (1 << 25) != 0 {
            let rot = ((insn >> 8) & 0xF) * 2;
            let v = (insn & 0xFF).rotate_right(rot);
            if carry {
                if rot == 0 { self.e.get(LC).set(CY); } else { self.e.i32c(v >> 31).set(CY); }
            }
            self.e.i32c(v);
            return true;
        }
        let rm = insn & 0xF;
        let typ = (insn >> 5) & 3;
        if insn & 0x10 == 0 {
            let amt = (insn >> 7) & 0x1F;
            self.reg(rm, pc);
            self.e.set(T1);
            let e = &mut self.e;
            match (typ, amt) {
                (0, 0) => {
                    if carry { e.get(LC).set(CY); }
                    e.get(T1);
                }
                (0, n) => {
                    if carry { e.get(T1).i32c(32 - n).op(SHR_U).i32c(1).op(AND).set(CY); }
                    e.get(T1).i32c(n).op(SHL);
                }
                (1, 0) => {
                    if carry { e.get(T1).i32c(31).op(SHR_U).set(CY); }
                    e.i32c(0);
                }
                (1, n) => {
                    if carry { e.get(T1).i32c(n - 1).op(SHR_U).i32c(1).op(AND).set(CY); }
                    e.get(T1).i32c(n).op(SHR_U);
                }
                (2, 0) => {
                    if carry { e.get(T1).i32c(31).op(SHR_U).set(CY); }
                    e.get(T1).i32c(31).op(SHR_S);
                }
                (2, n) => {
                    if carry { e.get(T1).i32c(n - 1).op(SHR_U).i32c(1).op(AND).set(CY); }
                    e.get(T1).i32c(n).op(SHR_S);
                }
                (_, 0) => {
                    // RRX
                    if carry { e.get(T1).i32c(1).op(AND).set(CY); }
                    e.get(LC).i32c(31).op(SHL).get(T1).i32c(1).op(SHR_U).op(OR);
                }
                (_, n) => {
                    if carry { e.get(T1).i32c(n - 1).op(SHR_U).i32c(1).op(AND).set(CY); }
                    e.get(T1).i32c(n).op(ROTR);
                }
            }
            return true;
        }
        if insn & 0x80 != 0 {
            return false; // not a shifter operand (multiply / extra load-store space)
        }
        // register-specified shift: PC reads as +12; amount = Rs & 0xFF
        let rs = (insn >> 8) & 0xF;
        if rm == 15 { self.e.i32c(pc.wrapping_add(12)); } else { self.e.get(R0 + rm); }
        self.e.set(T1);
        if rs == 15 { self.e.i32c(pc.wrapping_add(12)); } else { self.e.get(R0 + rs); }
        self.e.i32c(0xFF).op(AND).set(T2);
        let e = &mut self.e;
        match typ {
            0 => {
                // W = zext(v) << min(a, 33): value = low 32, carry = bit 32 (a = 0 keeps C)
                e.get(T1).op(EXT_U);
                e.get(T2).i32c(33).get(T2).i32c(33).op(LT_U).op(SELECT).op(EXT_U).op(I64_SHL).set(W);
                if carry {
                    e.get(LC).get(W).i64c(32).op(I64_SHR_U).op(WRAP).i32c(1).op(AND).get(T2).op(EQZ).op(SELECT).set(CY);
                }
                e.get(W).op(WRAP);
            }
            1 | 2 => {
                // W = (ext(v) << 1) >> min(a, 33): value = W >> 1, carry = bit 0
                e.get(T1).op(if typ == 1 { EXT_U } else { EXT_S }).i64c(1).op(I64_SHL);
                e.get(T2).i32c(33).get(T2).i32c(33).op(LT_U).op(SELECT).op(EXT_U);
                e.op(if typ == 1 { I64_SHR_U } else { I64_SHR_S }).set(W);
                if carry {
                    e.get(LC).get(W).op(WRAP).i32c(1).op(AND).get(T2).op(EQZ).op(SELECT).set(CY);
                }
                // a == 0: value unchanged
                e.get(T1).get(W).i64c(1).op(I64_SHR_U).op(WRAP).get(T2).op(EQZ).op(SELECT);
            }
            _ => {
                e.get(T1).get(T2).op(ROTR).set(T3);
                if carry {
                    e.get(LC).get(T3).i32c(31).op(SHR_U).get(T2).op(EQZ).op(SELECT).set(CY);
                }
                e.get(T3);
            }
        }
        true
    }

    // ---- instruction groups -------------------------------------------------------------------
    /// Returns Some(terminal) if translated: terminal = the instruction ends the block.
    fn arm(&mut self, insn: u32, pc: u32) -> Option<bool> {
        let cond = insn >> 28;
        if cond == 0xF {
            if insn & 0x0D70_F000 == 0x0550_F000 {
                return Some(false); // PLD
            }
            if insn & 0x0E00_0000 == 0x0A00_0000 {
                // BLX imm: always taken, switches to Thumb
                let off = (((insn & 0x00FF_FFFF) << 8) as i32 >> 6) as u32;
                let h = (insn >> 24) & 1;
                self.e.i32c(pc.wrapping_add(4));
                self.set_reg(14);
                self.jump(pc.wrapping_add(8).wrapping_add(off).wrapping_add(h << 1), true);
                return Some(true);
            }
            return None;
        }
        let class = (insn >> 25) & 7;
        // classify first, emit only if supported
        let kind = match class {
            0 => {
                if insn & 0x0FFF_FFD0 == 0x012F_FF10 { 1 } // BX/BLX reg
                else if insn & 0x0FFF_0FF0 == 0x016F_0F10 { 2 } // CLZ
                else if insn & 0x0FC0_00F0 == 0x0000_0090 { 3 } // MUL/MLA
                else if insn & 0x0F80_00F0 == 0x0080_0090 { 4 } // long multiply
                else if insn & 0x0E00_0090 == 0x0000_0090 && insn & 0x60 != 0 { 5 } // extra load/store
                else if insn & 0x90 != 0x90 && insn & 0x0190_0000 != 0x0100_0000 { 6 } // data processing
                else { 0 }
            }
            1 => if insn & 0x0190_0000 != 0x0100_0000 { 6 } else { 0 },
            2 => 7,
            3 => if insn & 0x10 == 0 { 7 } else { 0 },
            4 => 8,
            5 => 9,
            _ => 0,
        };
        if kind == 0 {
            return None;
        }
        // conditional execution: wrap; terminal instructions set NPC in both arms
        let conditional = cond != 0xE;
        let terminal = self.is_terminal(insn, kind);
        if conditional {
            self.cond(cond);
            self.e.if_();
        }
        let ok = match kind {
            1 => {
                let rm = insn & 0xF;
                self.reg(rm, pc);
                if insn & 0x20 != 0 {
                    self.e.set(T2).i32c(pc.wrapping_add(4));
                    self.set_reg(14);
                    self.e.get(T2);
                }
                self.bx_from_stack();
                true
            }
            2 => {
                self.reg(insn & 0xF, pc);
                self.e.op(CLZ);
                self.set_reg((insn >> 12) & 0xF);
                true
            }
            3 => self.mul(insn, pc),
            4 => self.long_mul(insn, pc),
            5 => self.extra_ls(insn, pc),
            6 => self.data_processing(insn, pc),
            7 => self.load_store(insn, pc),
            8 => self.block_transfer(insn, pc),
            _ => {
                let off = (((insn & 0x00FF_FFFF) << 8) as i32 >> 6) as u32;
                if insn & 0x0100_0000 != 0 {
                    self.e.i32c(pc.wrapping_add(4));
                    self.set_reg(14);
                }
                let target = pc.wrapping_add(8).wrapping_add(off);
                if target == self.entry {
                    // self loop: continue in the wasm loop while budget remains
                    self.e.get(ITER).i32c(BUDGET as u32).op(LT_U).op(0x0D).uleb(if conditional { 1 } else { 0 });
                }
                self.jump(target, false);
                true
            }
        };
        if !ok {
            return None; // caller truncates whatever was emitted for this instruction
        }
        if conditional {
            if terminal {
                self.e.else_();
                self.jump(pc.wrapping_add(4), false);
            }
            self.e.end();
        }
        Some(terminal)
    }

    /// Does this instruction write PC (and therefore end the block)?
    fn is_terminal(&self, insn: u32, kind: u32) -> bool {
        let rd = (insn >> 12) & 0xF;
        match kind {
            1 | 9 => true,
            6 => {
                let op = (insn >> 21) & 0xF;
                rd == 15 && !(0x8..=0xB).contains(&op)
            }
            7 => insn & (1 << 20) != 0 && rd == 15,
            8 => insn & (1 << 20) != 0 && insn & 0x8000 != 0,
            5 => insn & (1 << 20) != 0 && rd == 15,
            _ => false,
        }
    }

    fn data_processing(&mut self, insn: u32, pc: u32) -> bool {
        let op = (insn >> 21) & 0xF;
        let s = insn & (1 << 20) != 0;
        let rn = (insn >> 16) & 0xF;
        let rd = (insn >> 12) & 0xF;
        let test = (0x8..=0xB).contains(&op);
        let flags = test || (s && rd != 15);
        let logical = matches!(op, 0x0 | 0x1 | 0x8 | 0x9 | 0xC | 0xD | 0xE | 0xF);
        // operand 2 -> T2 (CY if logical with flags)
        if !self.operand2(insn, pc, flags && logical) {
            return false;
        }
        self.e.set(T2);
        if op != 0xD && op != 0xF {
            self.reg(rn, pc);
            self.e.set(T1);
        }
        if logical {
            {
                let e = &mut self.e;
                match op {
                    0x0 | 0x8 => { e.get(T1).get(T2).op(AND); }
                    0x1 | 0x9 => { e.get(T1).get(T2).op(XOR); }
                    0xC => { e.get(T1).get(T2).op(OR); }
                    0xD => { e.get(T2); }
                    0xE => { e.get(T1).get(T2).i32c(u32::MAX).op(XOR).op(AND); }
                    _ => { e.get(T2).i32c(u32::MAX).op(XOR); }
                }
                e.set(T3);
            }
            if flags {
                self.flag_nz_from(T3);
                self.e.get(CY).set(LC);
            }
        } else {
            // add-with-carry form: a + b' + cin
            let (b_inv, cin) = match op {
                0x2 | 0xA => (true, Cin::One),   // SUB/CMP: rn + !op2 + 1
                0x3 => (false, Cin::One),        // RSB: op2 + !rn + 1 (swapped below)
                0x4 | 0xB => (false, Cin::Zero), // ADD/CMN
                0x5 => (false, Cin::Carry),      // ADC
                0x6 => (true, Cin::Carry),       // SBC
                _ => (false, Cin::Carry),        // RSC
            };
            let swap = matches!(op, 0x3 | 0x7);
            // normalise to A_ = a, B_ = b' in T1/T2
            if swap {
                // a = op2 (T2), b = !rn (T1)
                self.e.get(T2).get(T1).i32c(u32::MAX).op(XOR).set(T2).set(T1);
            } else if b_inv {
                self.e.get(T2).i32c(u32::MAX).op(XOR).set(T2);
            }
            self.add_with_carry(cin, flags);
        }
        if test {
            return true;
        }
        self.e.get(T3);
        if rd == 15 {
            self.bx_from_stack();
        } else {
            self.set_reg(rd);
        }
        true
    }

    /// T3 = T1 + T2 + cin (64-bit); flags from the sum when requested.
    fn add_with_carry(&mut self, cin: Cin, flags: bool) {
        let e = &mut self.e;
        e.get(T1).op(EXT_U).get(T2).op(EXT_U).op(I64_ADD);
        match cin {
            Cin::Zero => {}
            Cin::One => { e.i64c(1).op(I64_ADD); }
            Cin::Carry => { e.get(LC).op(EXT_U).op(I64_ADD); }
        }
        e.tee(W).op(WRAP).set(T3);
        if flags {
            e.get(W).i64c(32).op(I64_SHR_U).op(WRAP).set(LC);
            e.get(T1).get(T3).op(XOR).get(T2).get(T3).op(XOR).op(AND).i32c(31).op(SHR_U).set(LV);
            self.flag_nz_from(T3);
        }
    }

    fn mul(&mut self, insn: u32, pc: u32) -> bool {
        let rd = (insn >> 16) & 0xF;
        self.reg(insn & 0xF, pc);
        self.reg((insn >> 8) & 0xF, pc);
        self.e.op(MUL);
        if insn & (1 << 21) != 0 {
            self.reg((insn >> 12) & 0xF, pc);
            self.e.op(ADD);
        }
        self.e.set(T3);
        if insn & (1 << 20) != 0 {
            self.flag_nz_from(T3);
        }
        self.e.get(T3);
        self.set_reg(rd);
        true
    }

    fn long_mul(&mut self, insn: u32, pc: u32) -> bool {
        let hi = (insn >> 16) & 0xF;
        let lo = (insn >> 12) & 0xF;
        let signed = insn & (1 << 22) != 0;
        let ext = if signed { EXT_S } else { EXT_U };
        self.reg(insn & 0xF, pc);
        self.e.op(ext);
        self.reg((insn >> 8) & 0xF, pc);
        self.e.op(ext).op(I64_MUL);
        if insn & (1 << 21) != 0 {
            self.reg(hi, pc);
            self.e.op(EXT_U).i64c(32).op(I64_SHL);
            self.reg(lo, pc);
            self.e.op(EXT_U).op(0x84).op(I64_ADD); // i64.or, i64.add
        }
        self.e.set(W);
        self.e.get(W).op(WRAP);
        self.set_reg(lo);
        self.e.get(W).i64c(32).op(I64_SHR_U).op(WRAP);
        self.set_reg(hi);
        if insn & (1 << 20) != 0 {
            self.e.get(W).i64c(63).op(I64_SHR_U).op(WRAP).set(LN);
            self.e.get(W).op(I64_EQZ).set(LZ);
            self.flags_written = true;
        }
        true
    }

    /// Compute (offset address -> T1, access address -> A) for single transfers.
    fn address(&mut self, rn: u32, pc: u32, p: bool, u: bool) {
        // offset is on the stack
        self.e.set(T1);
        self.reg(rn, pc);
        self.e.set(A);
        self.e.get(A).get(T1).op(if u { ADD } else { SUB }).set(T1);
        if p {
            self.e.get(T1).set(A);
        }
    }

    fn load_store(&mut self, insn: u32, pc: u32) -> bool {
        let p = insn & (1 << 24) != 0;
        let u = insn & (1 << 23) != 0;
        let b = insn & (1 << 22) != 0;
        let w = insn & (1 << 21) != 0;
        let l = insn & (1 << 20) != 0;
        let rn = (insn >> 16) & 0xF;
        let rd = (insn >> 12) & 0xF;
        let wb = !p || w;
        if wb && rn == 15 {
            return false;
        }
        if insn & (1 << 25) == 0 {
            self.e.i32c(insn & 0xFFF);
        } else if !self.operand2(insn & !(1 << 25), pc, false) {
            return false;
        }
        self.address(rn, pc, p, u);
        if l {
            self.load(if b { 1 } else { 4 });
            self.e.set(T2);
            if wb {
                self.e.get(T1);
                self.set_reg(rn);
            }
            self.e.get(T2);
            if rd == 15 { self.bx_from_stack(); } else { self.set_reg(rd); }
        } else {
            self.reg(rd, pc);
            self.e.set(T2);
            self.store(if b { 1 } else { 4 });
            if wb {
                self.e.get(T1);
                self.set_reg(rn);
            }
        }
        true
    }

    fn extra_ls(&mut self, insn: u32, pc: u32) -> bool {
        let p = insn & (1 << 24) != 0;
        let u = insn & (1 << 23) != 0;
        let i = insn & (1 << 22) != 0;
        let w = insn & (1 << 21) != 0;
        let l = insn & (1 << 20) != 0;
        let rn = (insn >> 16) & 0xF;
        let rd = (insn >> 12) & 0xF;
        let sh = (insn >> 5) & 3;
        let wb = !p || w;
        if (wb && rn == 15) || (!l && sh >= 2 && rd >= 14) {
            return false; // PC writeback / LDRD-STRD with r14-r15: leave to the interpreter
        }
        if i {
            self.e.i32c(((insn >> 4) & 0xF0) | (insn & 0xF));
        } else {
            self.reg(insn & 0xF, pc);
        }
        self.address(rn, pc, p, u);
        match (l, sh) {
            (true, 1) | (true, 2) | (true, 3) => {
                if sh == 1 { self.load(2); } else if sh == 2 { self.load(1); } else { self.load(2); }
                match sh {
                    2 => { self.e.i32c(24).op(SHL).i32c(24).op(SHR_S); }
                    3 => { self.e.i32c(16).op(SHL).i32c(16).op(SHR_S); }
                    _ => {}
                }
                self.e.set(T2);
                if wb {
                    self.e.get(T1);
                    self.set_reg(rn);
                }
                self.e.get(T2);
                if rd == 15 { self.bx_from_stack(); } else { self.set_reg(rd); }
            }
            (false, 1) => {
                self.reg(rd, pc);
                self.e.set(T2);
                self.store(2);
                if wb {
                    self.e.get(T1);
                    self.set_reg(rn);
                }
            }
            (false, 2) => {
                // LDRD: rd, rd+1
                if rd >= 14 {
                    return false;
                }
                self.load(4);
                self.e.set(T2);
                self.e.get(A).i32c(4).op(ADD).set(A);
                self.load(4);
                self.e.set(T3);
                if wb {
                    self.e.get(T1);
                    self.set_reg(rn);
                }
                self.e.get(T2);
                self.set_reg(rd);
                self.e.get(T3);
                self.set_reg(rd + 1);
            }
            (false, 3) => {
                // STRD
                if rd >= 14 {
                    return false;
                }
                self.reg(rd, pc);
                self.e.set(T2);
                self.store(4);
                self.e.get(A).i32c(4).op(ADD).set(A);
                self.reg(rd + 1, pc);
                self.e.set(T2);
                self.store(4);
                if wb {
                    self.e.get(T1);
                    self.set_reg(rn);
                }
            }
            _ => return false,
        }
        true
    }

    fn block_transfer(&mut self, insn: u32, pc: u32) -> bool {
        let p = insn & (1 << 24) != 0;
        let u = insn & (1 << 23) != 0;
        let s = insn & (1 << 22) != 0;
        let w = insn & (1 << 21) != 0;
        let l = insn & (1 << 20) != 0;
        let rn = (insn >> 16) & 0xF;
        let list = insn & 0xFFFF;
        let count = list.count_ones();
        if s || rn == 15 || list == 0 {
            return false;
        }
        // start address -> ST, new base -> T1
        self.reg(rn, pc);
        self.e.set(T1);
        let start: i64 = match (p, u) {
            (false, true) => 0,
            (true, true) => 4,
            (false, false) => 4 - 4 * count as i64,
            (true, false) => -4 * count as i64,
        };
        self.e.get(T1).i32c(start as i32 as u32).op(ADD).set(ST);
        let delta = if u { 4 * count } else { (4 * count).wrapping_neg() };
        self.e.get(T1).i32c(delta).op(ADD).set(T1);
        if l {
            if w {
                self.e.get(T1);
                self.set_reg(rn);
            }
            let mut k = 0;
            for i in 0..16 {
                if list & (1 << i) != 0 {
                    self.e.get(ST).i32c(4 * k).op(ADD).set(A);
                    self.load(4);
                    if i == 15 { self.bx_from_stack(); } else { self.set_reg(i); }
                    k += 1;
                }
            }
        } else {
            let mut k = 0;
            for i in 0..16 {
                if list & (1 << i) != 0 {
                    self.e.get(ST).i32c(4 * k).op(ADD).set(A);
                    self.reg(i, pc);
                    self.e.set(T2);
                    self.store(4);
                    k += 1;
                }
            }
            if w {
                self.e.get(T1);
                self.set_reg(rn);
            }
        }
        true
    }

    /// Emit the block body (inside the loop). Returns (body bytes, instruction count).
    fn body(&mut self, entry: u32) -> Option<(Vec<u8>, usize)> {
        let mut pc = entry;
        let mut n = 0usize;
        let mut terminated = false;
        // Chrome only compiles modules up to 4 KB synchronously on the main thread: keep blocks small.
        while n < MAX_INSNS && self.e.b.len() < MAX_BODY_BYTES {
            let insn = self.cpu.mem.r32(pc).ok()?;
            let mark = self.e.b.len();
            let (w0, f0) = (self.written, self.flags_written);
            match self.arm(insn, pc) {
                Some(term) => {
                    n += 1;
                    if term {
                        terminated = true;
                        break;
                    }
                    pc = pc.wrapping_add(4);
                }
                None => {
                    self.e.b.truncate(mark);
                    self.written = w0;
                    self.flags_written = f0;
                    break;
                }
            }
        }
        if n == 0 {
            return None;
        }
        if !terminated {
            self.jump(pc, false);
        }
        Some((std::mem::take(&mut self.e.b), n))
    }
}

/// Wrap a block body into a complete module.
fn module(body: &[u8], n_insns: usize, written: u16, flags_written: bool) -> Vec<u8> {
    // locate fields
    let off_r = offset_of!(Cpu, r) as u32;
    let off_n = offset_of!(Cpu, n) as u32;
    let off_z = offset_of!(Cpu, z) as u32;
    let off_c = offset_of!(Cpu, c) as u32;
    let off_v = offset_of!(Cpu, v) as u32;
    let off_t = offset_of!(Cpu, t) as u32;
    let off_exec = offset_of!(Cpu, executed) as u32;
    let off_tbl = offset_of!(Cpu, jit_tbl) as u32;
    let off_data = offset_of!(Cpu, jit_data) as u32;

    let mut f = E::default();
    // locals: 31 x i32, 1 x i64
    f.uleb(2).uleb(N_I32_LOCALS as u64).op(0x7F).uleb(N_I64_LOCALS as u64).op(0x7E);
    // prologue: load registers and flags
    for r in 0..15u32 {
        f.get(0).mem(0x28, 2, off_r + 4 * r).set(R0 + r);
    }
    for (l, off) in [(LN, off_n), (LZ, off_z), (LC, off_c), (LV, off_v)] {
        f.get(0).mem(0x2D, 0, off).set(l);
    }
    f.get(0).mem(0x28, 2, off_tbl).set(TBL);
    f.get(0).mem(0x28, 2, off_data).set(DATA);
    f.i32c(0).set(ITER);
    // loop body
    f.op(0x03).op(0x40); // loop
    f.get(ITER).i32c(1).op(ADD).set(ITER);
    f.b.extend_from_slice(body);
    f.end(); // loop
    // epilogue: write back
    for r in 0..15u32 {
        if written & (1 << r) != 0 {
            f.get(0).get(R0 + r).mem(0x36, 2, off_r + 4 * r);
        }
    }
    if flags_written {
        for (l, off) in [(LN, off_n), (LZ, off_z), (LC, off_c), (LV, off_v)] {
            f.get(0).get(l).mem(0x3A, 0, off);
        }
    }
    f.get(0).get(NPC).mem(0x36, 2, off_r + 60);
    f.get(0).get(NT).mem(0x3A, 0, off_t);
    // executed += iterations * block length (every pass runs the whole block)
    f.get(0).get(0).mem(0x29, 3, off_exec).get(ITER).op(EXT_U).i64c(n_insns as i64).op(I64_MUL).op(I64_ADD)
        .mem(0x37, 3, off_exec);
    f.i32c(0);
    f.end(); // function
    let mut m = Vec::new();
    m.extend_from_slice(b"\0asm\x01\0\0\0");
    let sec = |id: u8, content: &[u8], m: &mut Vec<u8>| {
        m.push(id);
        let mut e = E::default();
        e.uleb(content.len() as u64);
        m.extend_from_slice(&e.b);
        m.extend_from_slice(content);
    };
    // types: 0 = (i32)->i32, 1 = (i32,i32)->()
    let types = [2u8, 0x60, 1, 0x7F, 1, 0x7F, 0x60, 2, 0x7F, 0x7F, 0];
    sec(1, &types[..], &mut m);
    // imports
    let mut imp = E::default();
    imp.uleb(7);
    let name = |e: &mut E, s: &str| {
        e.uleb(s.len() as u64);
        e.b.extend_from_slice(s.as_bytes());
    };
    name(&mut imp, "env");
    name(&mut imp, "memory");
    imp.op(0x02).op(0x00).uleb(1);
    for (nm, ty) in [("ld8", 0u64), ("ld16", 0), ("ld32", 0), ("st8", 1), ("st16", 1), ("st32", 1)] {
        name(&mut imp, "env");
        name(&mut imp, nm);
        imp.op(0x00).uleb(ty);
    }
    sec(2, &imp.b, &mut m);
    sec(3, &[1, 0], &mut m); // one function of type 0
    let mut exp = E::default();
    exp.uleb(1);
    name(&mut exp, "f");
    exp.op(0x00).uleb(F_SELF as u64);
    sec(7, &exp.b, &mut m);
    let mut code = E::default();
    code.uleb(1).uleb(f.b.len() as u64);
    code.b.extend_from_slice(&f.b);
    sec(10, &code.b, &mut m);
    m
}
