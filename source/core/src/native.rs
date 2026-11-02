//! Native replacements for hot guest routines. Guestlib helpers are entered through a reserved
//! `UDF #op` instruction written at their entry; the game's own blit is hooked by address (its
//! code stays untouched because the DRM may checksum the executable).

use crate::cpu::{Cpu, LR};
use crate::mem::Fault;

pub const UDIVMOD: u32 = 1;
pub const IDIVMOD: u32 = 2;
pub const MEMCPY: u32 = 3;
pub const MEMMOVE: u32 = 4;
pub const MEMSET: u32 = 5; // __aeabi_memset(dst, n, c)
pub const MEMCLR: u32 = 6; // __aeabi_memclr(dst, n)
pub const BLIT565: u32 = 7;

/// ARM `UDF #imm16` (cond = AL): permanently undefined, so it can never clash with real code.
pub fn udf(op: u32) -> u32 {
    0xE7F0_00F0 | ((op >> 4) << 8) | (op & 0xF)
}

pub fn decode_udf(insn: u32) -> Option<u32> {
    if insn & 0xFFF0_00F0 == 0xE7F0_00F0 { Some(((insn >> 8) & 0xFFF) << 4 | (insn & 0xF)) } else { None }
}

fn copy(cpu: &mut Cpu, dst: u32, src: u32, n: u32) -> Result<(), Fault> {
    if n == 0 {
        return Ok(());
    }
    let mut buf = vec![0u8; n as usize];
    cpu.mem.read_bytes(src, &mut buf)?;
    cpu.mem.write_bytes(dst, &buf)
}

/// Run native op `op`, then return to the caller like `bx lr`.
pub fn run(cpu: &mut Cpu, op: u32) -> Result<bool, Fault> {
    let r = cpu.r;
    match op {
        UDIVMOD => {
            let (n, d) = (r[0], r[1]);
            let (q, m) = if d == 0 { (0, n) } else { (n / d, n % d) };
            cpu.r[0] = q;
            cpu.r[1] = m;
        }
        IDIVMOD => {
            let (n, d) = (r[0] as i32, r[1] as i32);
            let (q, m) = if d == 0 { (0, n) } else { (n.wrapping_div(d), n.wrapping_rem(d)) };
            cpu.r[0] = q as u32;
            cpu.r[1] = m as u32;
        }
        // Forward copy for memcpy matches the ARM helper; memmove copies through a buffer,
        // which is correct for any overlap.
        MEMCPY | MEMMOVE => copy(cpu, r[0], r[1], r[2])?,
        MEMSET | MEMCLR => {
            let c = if op == MEMSET { r[2] as u8 } else { 0 };
            if r[1] != 0 {
                cpu.mem.write_bytes(r[0], &vec![c; r[1] as usize])?;
            }
        }
        BLIT565 => blit565(cpu)?,
        _ => return Ok(false),
    }
    let lr = cpu.r[LR];
    cpu.bx(lr);
    Ok(true)
}

/// Game routine at 0xefec: Blit(src565, dst8888, rows, (groups16 << 20 | dst_pad_words)).
/// Each row converts groups16*16 pixels, then skips a 16-pixel (32-byte) source guard and
/// `dst_pad_words` destination words. Pixel: 0x00RRGGBB with the low bits of each channel zero.
fn blit565(cpu: &mut Cpu) -> Result<(), Fault> {
    let (mut src, mut dst, rows, packed) = (cpu.r[0], cpu.r[1], cpu.r[2], cpu.r[3]);
    let width = (packed >> 20) * 16;
    let pad = (packed & 0xFFFF) << 2;
    let mut line = vec![0u8; width as usize * 2];
    let mut out = vec![0u8; width as usize * 4];
    for _ in 0..rows {
        cpu.mem.read_bytes(src, &mut line)?;
        for x in 0..width as usize {
            let p = u16::from_le_bytes([line[2 * x], line[2 * x + 1]]) as u32;
            let v = ((p << 3) & 0xF8) | ((p << 5) & 0xFC00) | ((p << 8) & 0xF8_0000);
            out[4 * x..4 * x + 4].copy_from_slice(&v.to_le_bytes());
        }
        cpu.mem.write_bytes(dst, &out)?;
        src = src.wrapping_add(width * 2 + 0x20);
        dst = dst.wrapping_add(width * 4 + pad);
    }
    Ok(())
}
