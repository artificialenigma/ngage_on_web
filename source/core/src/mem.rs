//! Paged guest memory: a 4 KB page table over one growable backing buffer.

pub const PAGE_BITS: u32 = 12;
pub const PAGE_SIZE: u32 = 1 << PAGE_BITS;
const NONE: u32 = u32::MAX;

pub struct Memory {
    table: Vec<u32>, // page index -> byte offset into `data`, or NONE
    pub data: Vec<u8>,
}

#[derive(Clone, Copy, Debug)]
pub struct Fault {
    pub addr: u32,
    pub write: bool,
}

impl Memory {
    pub fn new() -> Self {
        Memory { table: vec![NONE; 1 << (32 - PAGE_BITS)], data: Vec::new() }
    }

    /// Map [addr, addr+size) (page granular, zero filled). Already-mapped pages are kept.
    pub fn map(&mut self, addr: u32, size: u32) {
        let first = addr >> PAGE_BITS;
        let last = ((addr as u64 + size as u64 + PAGE_SIZE as u64 - 1) >> PAGE_BITS) as u32;
        for p in first..last {
            if self.table[p as usize] == NONE {
                let off = self.data.len() as u32;
                self.data.resize(self.data.len() + PAGE_SIZE as usize, 0);
                self.table[p as usize] = off;
            }
        }
    }

    /// Base addresses the JIT reads (both can move when `map` grows the buffers).
    pub fn table_ptr(&self) -> *const u32 {
        self.table.as_ptr()
    }

    /// Byte offset of a mapped address in `data` (used by the CPU's instruction-fetch cache).
    #[inline(always)]
    pub fn page_offset(&self, addr: u32) -> Option<usize> {
        self.off(addr)
    }

    #[inline(always)]
    fn off(&self, addr: u32) -> Option<usize> {
        let base = unsafe { *self.table.get_unchecked((addr >> PAGE_BITS) as usize) };
        if base == NONE { None } else { Some((base + (addr & (PAGE_SIZE - 1))) as usize) }
    }

    #[inline(always)]
    pub fn r8(&self, addr: u32) -> Result<u32, Fault> {
        match self.off(addr) {
            Some(o) => Ok(unsafe { *self.data.get_unchecked(o) } as u32),
            None => Err(Fault { addr, write: false }),
        }
    }

    #[inline(always)]
    pub fn r16(&self, addr: u32) -> Result<u32, Fault> {
        if addr & (PAGE_SIZE - 1) <= PAGE_SIZE - 2 {
            match self.off(addr) {
                Some(o) => Ok(unsafe { (self.data.as_ptr().add(o) as *const u16).read_unaligned() } as u32),
                None => Err(Fault { addr, write: false }),
            }
        } else {
            Ok(self.r8(addr)? | (self.r8(addr.wrapping_add(1))? << 8))
        }
    }

    #[inline(always)]
    pub fn r32(&self, addr: u32) -> Result<u32, Fault> {
        if addr & (PAGE_SIZE - 1) <= PAGE_SIZE - 4 {
            match self.off(addr) {
                Some(o) => Ok(unsafe { (self.data.as_ptr().add(o) as *const u32).read_unaligned() }),
                None => Err(Fault { addr, write: false }),
            }
        } else {
            Ok(self.r16(addr)? | (self.r16(addr.wrapping_add(2))? << 16))
        }
    }

    #[inline(always)]
    pub fn w8(&mut self, addr: u32, v: u32) -> Result<(), Fault> {
        match self.off(addr) {
            Some(o) => {
                self.data[o] = v as u8;
                Ok(())
            }
            None => Err(Fault { addr, write: true }),
        }
    }

    #[inline(always)]
    pub fn w16(&mut self, addr: u32, v: u32) -> Result<(), Fault> {
        if addr & (PAGE_SIZE - 1) <= PAGE_SIZE - 2 {
            match self.off(addr) {
                Some(o) => {
                    unsafe { (self.data.as_mut_ptr().add(o) as *mut u16).write_unaligned(v as u16) };
                    Ok(())
                }
                None => Err(Fault { addr, write: true }),
            }
        } else {
            self.w8(addr, v)?;
            self.w8(addr.wrapping_add(1), v >> 8)
        }
    }

    #[inline(always)]
    pub fn w32(&mut self, addr: u32, v: u32) -> Result<(), Fault> {
        if addr & (PAGE_SIZE - 1) <= PAGE_SIZE - 4 {
            match self.off(addr) {
                Some(o) => {
                    unsafe { (self.data.as_mut_ptr().add(o) as *mut u32).write_unaligned(v) };
                    Ok(())
                }
                None => Err(Fault { addr, write: true }),
            }
        } else {
            self.w16(addr, v)?;
            self.w16(addr.wrapping_add(2), v >> 16)
        }
    }

    pub fn read_bytes(&self, addr: u32, out: &mut [u8]) -> Result<(), Fault> {
        let mut i = 0usize;
        while i < out.len() {
            let a = addr.wrapping_add(i as u32);
            let o = self.off(a).ok_or(Fault { addr: a, write: false })?;
            let n = ((PAGE_SIZE - (a & (PAGE_SIZE - 1))) as usize).min(out.len() - i);
            out[i..i + n].copy_from_slice(&self.data[o..o + n]);
            i += n;
        }
        Ok(())
    }

    pub fn write_bytes(&mut self, addr: u32, src: &[u8]) -> Result<(), Fault> {
        let mut i = 0usize;
        while i < src.len() {
            let a = addr.wrapping_add(i as u32);
            let o = self.off(a).ok_or(Fault { addr: a, write: true })?;
            let n = ((PAGE_SIZE - (a & (PAGE_SIZE - 1))) as usize).min(src.len() - i);
            self.data[o..o + n].copy_from_slice(&src[i..i + n]);
            i += n;
        }
        Ok(())
    }
}
