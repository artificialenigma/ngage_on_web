//! C ABI over one global CPU, shared by the native build (Python ctypes, for testing against
//! Unicorn) and the wasm32 build (browser). Registers: 0-15 = r0-r15, 16 = CPSR.
//! Bulk memory transfers go through a host-visible scratch buffer.

pub mod cpu;
pub mod image;
pub mod jit;
pub mod mem;
pub mod native;

use cpu::{Cpu, Stop};

static mut CPU: Option<Cpu> = None;
static mut SCRATCH: Vec<u8> = Vec::new();

#[allow(static_mut_refs)]
fn cpu() -> &'static mut Cpu {
    unsafe { CPU.get_or_insert_with(Cpu::new) }
}

#[allow(static_mut_refs)]
fn scratch() -> &'static mut Vec<u8> {
    unsafe { &mut SCRATCH }
}

/// Reset everything (memory included).
#[no_mangle]
pub extern "C" fn core_reset() {
    unsafe { CPU = Some(Cpu::new()) }
}

#[no_mangle]
pub extern "C" fn core_set_trap_base(addr: u32) {
    cpu().trap_base = addr;
}

#[no_mangle]
pub extern "C" fn core_mem_map(addr: u32, size: u32) {
    cpu().mem.map(addr, size);
}

/// Pointer to a scratch buffer of at least `len` bytes (host copies data in/out through it).
#[no_mangle]
pub extern "C" fn core_scratch(len: u32) -> *mut u8 {
    let s = scratch();
    if s.len() < len as usize {
        s.resize(len as usize, 0);
    }
    s.as_mut_ptr()
}

/// Copy guest memory into the scratch buffer. Returns 0 on success, 1 on fault.
#[no_mangle]
pub extern "C" fn core_mem_read(addr: u32, len: u32) -> u32 {
    let p = core_scratch(len);
    let out = unsafe { std::slice::from_raw_parts_mut(p, len as usize) };
    match cpu().mem.read_bytes(addr, out) {
        Ok(()) => 0,
        Err(f) => {
            cpu().fault = f;
            1
        }
    }
}

/// Copy `len` bytes from the scratch buffer into guest memory. Returns 0 on success.
#[no_mangle]
pub extern "C" fn core_mem_write(addr: u32, len: u32) -> u32 {
    let src = unsafe { std::slice::from_raw_parts(scratch().as_ptr(), len as usize) };
    match cpu().mem.write_bytes(addr, src) {
        Ok(()) => 0,
        Err(f) => {
            cpu().fault = f;
            1
        }
    }
}

#[no_mangle]
pub extern "C" fn core_r32(addr: u32) -> u32 {
    cpu().mem.r32(addr).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn core_w32(addr: u32, v: u32) -> u32 {
    match cpu().mem.w32(addr, v) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

#[no_mangle]
pub extern "C" fn core_reg_read(i: u32) -> u32 {
    let c = cpu();
    if i < 16 { c.r[i as usize] } else { c.cpsr() }
}

/// Writing r15 with bit 0 set switches to Thumb (like Unicorn).
#[no_mangle]
pub extern "C" fn core_reg_write(i: u32, v: u32) {
    let c = cpu();
    match i {
        15 => {
            if v & 1 != 0 {
                c.t = true;
            }
            c.r[15] = v & !1;
        }
        16 => c.set_cpsr(v),
        _ => c.r[i as usize] = v,
    }
}

/// Run until PC == until, PC >= trap base, a fault, or `limit` instructions (0 = no limit).
#[no_mangle]
pub extern "C" fn core_run(until: u32, limit: u32) -> u32 {
    cpu().run(until, limit as u64) as u32
}

/// Return from a trap: PC = LR, with interworking (the trap slot's "bx lr").
#[no_mangle]
pub extern "C" fn core_trap_return() {
    let c = cpu();
    let lr = c.r[cpu::LR];
    c.bx(lr);
}

#[no_mangle]
pub extern "C" fn core_stop() {
    cpu().stop_requested = true;
}

#[no_mangle]
pub extern "C" fn core_fault_addr() -> u32 {
    cpu().fault.addr
}

#[no_mangle]
pub extern "C" fn core_fault_write() -> u32 {
    cpu().fault.write as u32
}

#[no_mangle]
pub extern "C" fn core_undefined_insn() -> u32 {
    cpu().undefined_insn
}

#[no_mangle]
pub extern "C" fn core_executed_lo() -> u32 {
    cpu().executed as u32
}

/// Turn the routine at `addr` into native op `op` by writing a UDF marker at its entry.
#[no_mangle]
pub extern "C" fn core_set_native(addr: u32, op: u32) -> u32 {
    cpu().mem.w32(addr, native::udf(op)).is_ok() as u32
}

/// Hook a routine by address without modifying its code (one PC compare per instruction).
#[no_mangle]
pub extern "C" fn core_set_hook(addr: u32, op: u32) {
    cpu().hook_pc = addr;
    cpu().hook_op = op;
}

// ---- JIT -------------------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn core_jit_enable(on: u32) {
    cpu().jit_enable(on != 0);
}

/// After core_run returns 6 (Compile): the module bytes to instantiate.
#[no_mangle]
pub extern "C" fn core_jit_req_ptr() -> *const u8 {
    cpu().jit_req.as_ptr()
}

#[no_mangle]
pub extern "C" fn core_jit_req_len() -> u32 {
    cpu().jit_req.len() as u32
}

#[no_mangle]
pub extern "C" fn core_jit_req_pc() -> u32 {
    cpu().jit_req_pc
}

/// Register the instantiated block (`f` = its index in __indirect_function_table).
#[no_mangle]
pub extern "C" fn core_jit_install(pc: u32, f: u32) {
    cpu().jit_install(pc, f);
}

#[no_mangle]
pub extern "C" fn core_jit_reject(pc: u32) {
    cpu().jit_install(pc, cpu::JIT_REJECT);
}

#[no_mangle]
pub extern "C" fn core_jit_blocks() -> u32 {
    cpu().jit_blocks
}

#[no_mangle]
pub extern "C" fn core_jit_ld8(a: u32) -> u32 { cpu().jit_ld(1, a) }
#[no_mangle]
pub extern "C" fn core_jit_ld16(a: u32) -> u32 { cpu().jit_ld(2, a) }
#[no_mangle]
pub extern "C" fn core_jit_ld32(a: u32) -> u32 { cpu().jit_ld(4, a) }
#[no_mangle]
pub extern "C" fn core_jit_st8(a: u32, v: u32) { cpu().jit_st(1, a, v) }
#[no_mangle]
pub extern "C" fn core_jit_st16(a: u32, v: u32) { cpu().jit_st(2, a, v) }
#[no_mangle]
pub extern "C" fn core_jit_st32(a: u32, v: u32) { cpu().jit_st(4, a, v) }

/// PC sampling profiler: record the PC every `every` instructions (0 = off).
#[no_mangle]
pub extern "C" fn core_prof_enable(every: u32) {
    cpu().prof_every = every as u64;
    cpu().prof.clear();
}

#[no_mangle]
pub extern "C" fn core_prof_count() -> u32 {
    cpu().prof.len() as u32
}

#[no_mangle]
pub extern "C" fn core_prof_get(i: u32) -> u32 {
    cpu().prof[i as usize]
}

#[no_mangle]
pub extern "C" fn core_thumb_executed_m() -> u32 {
    (cpu().thumb_executed / 1_000_000) as u32
}

#[no_mangle]
pub extern "C" fn core_executed_hi() -> u32 {
    (cpu().executed >> 32) as u32
}

static mut IMAGE: Option<image::Decoded> = None;

/// Decode a PNG/JPEG held in guest memory. Returns 1 on success; then query the size and copy
/// the BGR888 pixels into guest memory with core_image_copy.
#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn core_image_decode(addr: u32, len: u32) -> u32 {
    let mut buf = vec![0u8; len as usize];
    if cpu().mem.read_bytes(addr, &mut buf).is_err() {
        return 0;
    }
    unsafe {
        IMAGE = image::decode(&buf);
        IMAGE.is_some() as u32
    }
}

#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn core_image_width() -> u32 {
    unsafe { IMAGE.as_ref().map_or(0, |i| i.width) }
}

#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn core_image_height() -> u32 {
    unsafe { IMAGE.as_ref().map_or(0, |i| i.height) }
}

#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn core_image_copy(dst: u32) -> u32 {
    unsafe {
        match IMAGE.as_ref() {
            Some(i) => cpu().mem.write_bytes(dst, &i.bgr).is_ok() as u32,
            None => 0,
        }
    }
}

#[allow(dead_code)]
fn _assert_stop_codes() {
    let _ = [Stop::Until, Stop::Trap, Stop::Fault, Stop::Limit, Stop::Undefined, Stop::Requested];
}
