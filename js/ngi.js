// N-Gage 2.0 platform interfaces (CRuntime::CreateInstance objects). Mirrors hle_ngi.py.
// Browser additions: frames go to opts.onFrame, PCM to opts.onAudio, and IIdle::Process yields to
// the page once the virtual clock reaches the scheduler's target (real-time pacing).

import { OpenFile } from './vfs.js';
import { parseMidi } from './midi.js';

const OK = 0;
const E_GENERIC = (-1000000) >>> 0;
const E_NOT_FOUND = (-1000004) >>> 0;
const E_NOT_SUPPORTED = (-1000005) >>> 0;
const BB_RES_ID = 0x20, FMT_XRGB8888 = 0x40020, COUNTER_HZ = 1000000;
const FMT_RGB565 = 0x10010;                          // Brain Challenge renders 16-bit and copies it straight in

export const KEYS = { 1: 0x1, 2: 0x2, 3: 0x4, 4: 0x8, 5: 0x10, 6: 0x20, 7: 0x40, 8: 0x80, 9: 0x100, 0: 0x200,
  star: 0x400, hash: 0x800, lsk: 0x1000, rsk: 0x2000, clear: 0x4000, ok: 0x10000, up: 0x20000, down: 0x40000,
  left: 0x80000, right: 0x100000, send: 0x200000 };

const STUB_IIDS = new Set([0x301, 0x302, 0x304, 0x305, 0x306, 0x401, 0x602, 0x01000501, 0x01000a01, 0x04000101,
  0xc01, 0xc02, 0xc03, 0x01000631, 0x603, 0x01000601]);
const NAMES = { 0x01000101: 'PerfTiming', 0x101: 'Idle', 0x501: 'AppState', 0xa01: 'DisplayManager',
  0x701: 'BackBufferFactory', 0x601: 'Input', 0x603: 'KeypadCaps', 0x602: 'TextInput', 0x801: 'Audio',
  0xc01: 'Bitmap', 0xc02: 'ImageDecoder', 0xc03: 'GraphicsContext', 0x01000631: 'Orientation',
  0x01000601: 'GameSystemServices', 0x01000501: 'Achievements', 0x01000401: 'GameSaves',
  0x01000305: 'SystemPathInfo', 0x01000a01: 'Vibra', 0x04000101: 'NAF', 0x01000201: 'MemoryManager',
  0x02000101: 'FontFactory', 0x802: 'HighLevelAudio' };
// Interfaces reported as absent; the games tested fall back gracefully.
const UNSUPPORTED_IIDS = new Set();

const N_METHODS = 40;

/** RGB565 pixels -> XRGB8888 bytes (little-endian), the frame format the page and runner expect. */
function xrgbFrom565(raw, n) {
  const out = new Uint8Array(4 * n);
  for (let i = 0; i < n; i++) {
    const v = raw[2 * i] | (raw[2 * i + 1] << 8), r = v >> 11, g = (v >> 5) & 0x3F, b = v & 0x1F;
    out[4 * i] = (b << 3) | (b >> 2); out[4 * i + 1] = (g << 2) | (g >> 4); out[4 * i + 2] = (r << 3) | (r >> 2);
  }
  return out;
}

class NGIObject {
  constructor(ngi, name, size = 0x40, stub = false) {
    const h = ngi.h;
    this.ngi = ngi;
    this.h = h;
    this.name = name;
    this.stub = stub;
    this.addr = h.heap.alloc(size);
    this.vtbl = h.heap.alloc(4 * N_METHODS);
    h.w32(this.addr, this.vtbl);
    for (let k = 0; k < N_METHODS; k++) h.w32(this.vtbl + 4 * k, h.syntheticFn(`${name}[${k}]`, () => this.call(k)));
    this.methods = new Map([[0, () => 1], [1, () => 0], [2, () => 1], [3, () => this.addr], [4, () => this.addr]]);
  }

  on(slot, fn) { this.methods.set(slot, fn); return this; }

  call(k) {
    const fn = this.methods.get(k);
    if (!fn) {
      if (this.stub) return 0;
      const args = [0, 1, 2, 3].map((i) => '0x' + this.h.a(i).toString(16));
      this.h.fail(`unimplemented NGI method ${this.name} slot ${k} (this, a1..a3)=${args}`);
      return undefined;
    }
    return fn();
  }
}

export class NGI {
  constructor(h) {
    this.h = h;
    this.objects = new Map();          // iid -> [NGIObject]
    this.nowUs = 0;                    // virtual clock (microseconds)
    this.targetUs = Infinity;          // scheduler: yield once nowUs reaches this
    this.events = [];
    this.frames = 0;
    this.inputObs = 0;
    this.inputDev = null;
    this.appObs = 0;
    this.displayObs = 0;
    this.focused = false;
    this.audioObs = 0;
    this.audioStream = null;
    this.pendingKeys = [];
    this.pressedAt = new Map();
    this.keyScript = [];               // [[frame, down, bit]] for automated runs
    this.bb = null;
    // portrait games (Brain Challenge) use a 240x320 back buffer; most are landscape 320x240
    [this.bbW, this.bbH] = h.opts.game && h.opts.game.portrait ? [240, 320] : [320, 240];
  }

  obj(name, size, stub) { return new NGIObject(this, name, size, stub); }
  a(i) { return this.h.a(i); }
  out(p, v) { if (p) this.h.w32(p, v); return OK; }
  find(addr) {
    for (const list of this.objects.values()) for (const o of list) if (o.addr === addr) return o;
    return null;
  }

  /** Queue a key event. A release is held back until two frames after its press: the game samples
   *  key state once per frame, so a press and release delivered together would be missed. */
  key(down, bit) {
    if (down) this.pressedAt.set(bit, this.frames);
    const notBefore = down ? 0 : (this.pressedAt.get(bit) ?? -2) + 2;
    this.pendingKeys.push([down, bit, notBefore]);
  }

  create(iid) {
    const o = this.obj(NAMES[iid] || `iface0x${iid.toString(16)}`, 0x40, STUB_IIDS.has(iid));
    const a = (i) => this.a(i), h = this.h;
    switch (iid) {
      case 0x01000101:                                 // IPerformanceTiming
        o.on(5, () => (this.nowUs * 1000) >>> 0).on(6, () => 1000).on(7, () => this.nowUs >>> 0).on(8, () => COUNTER_HZ);
        break;
      case 0x101: o.on(5, () => this.idleProcess()); break;
      case 0x501: o.on(5, () => { this.appObs = a(1); }).on(6, () => 1); break;
      case 0x601: o.on(5, () => 1).on(6, () => this.inputDeviceInfo()).on(7, () => this.inputCreateDevice()); break;
      case 0xa01:
        o.on(7, () => this.out(a(2), this.makeDisplay().addr));
        o.on(6, () => E_NOT_SUPPORTED);                // (index, out): no second display (Brain Challenge)
        break;
      case 0x701: o.on(7, () => this.bbCreate()).on(10, () => this.bbConfiguration()); break;
      case 0x801:
        o.on(5, () => this.audioCaps()).on(6, () => 7).on(7, () => OK).on(8, () => OK).on(12, () => this.audioCreateStream());
        o.on(13, () => {                               // (IAudioOutput*& out, observer): Brain Challenge
          const ao = this.obj('AudioOutput');
          ao.observer = a(2);
          ao.on(5, () => { const dest = a(1) === ao.addr ? a(0) : a(1); [100, 0, 0, 0].forEach((v, i) => h.w32(dest + 4 * i, v)); return dest; });
          ao.on(7, () => OK).on(12, () => OK).on(14, () => OK);   // volume / setup
          this.audioOutput = ao;
          return this.out(a(1), ao.addr);
        });
        break;
      case 0xc01: this.makeBitmap(o); break;
      case 0xc02: o.on(8, () => this.decodeImage()); break;
      case 0x01000305: {                               // ISystemPathInfo
        o.on(5, () => 'e'.charCodeAt(0));
        const paths = { 6: `private\\${h.opts.game.uidHex}\\`, 8: 'E:\\', 9: 'C:\\Data\\', 10: 'Z:\\' };
        for (const [slot, text] of Object.entries(paths)) { const buf = h.allocWide(text); o.on(+slot, () => buf); }
        break;
      }
      case 0x01000401:                                 // IGameSaves
        o.on(5, () => this.savesOpen(true)).on(6, () => this.savesOpen(false));
        o.on(7, () => { this.h.vfs.remove('\\saves\\' + this.h.wstr(this.a(1))); return OK; });
        o.on(8, () => this.savesGetSize());
        break;
      case 0x01000601: o.on(6, () => 1); break;
      case 0x603: o.on(6, () => { this.out(a(2), 0); this.out(h.m.arg(3), 0); return OK; }); break;
      case 0x01000631:                                 // orientation helper: Get 6, Set 7
        o.on(5, () => this.out(a(1), 0)).on(6, () => this.out(a(1), 0));
        o.on(7, () => { this.events.push(['display', 0]); return OK; });   // the display re-reports its size
        break;
      case 0x01000201: o.on(5, () => this.createHeap()); break;          // IMemoryManager
      case 0x802: this.makeMixer(o); break;                              // high-level audio (MIDI songs)
      case 0x02000101:                                 // IFontFactory (system fonts)
        o.on(5, () => 1);                              // GetSystemFontCount
        o.on(6, () => {                                // GetSystemFontInformation(index, info*)
          const info = new Uint8Array(0x50), dv = new DataView(info.buffer);
          const name = 'Nokia Sans S60';
          for (let i = 0; i < name.length; i++) dv.setUint16(2 * i, name.charCodeAt(i), true);
          dv.setUint32(0x3c, 1, true); dv.setUint32(0x40, 1, true);   // the game wants +0x38 == 0, +0x3c and +0x40 set
          h.core.write(a(2), info);
          return OK;
        });
        o.on(9, () => {                                // CreateSystemFontInstance(IFont*&, info*, size, flags)
          const font = this.obj('Font');
          font.px = a(3);
          return this.out(a(1), font.addr);
        });
        break;
      default: break;
    }
    return o;
  }

  /** IMemoryManager::CreateHeap(IHeap*& out, size): a fixed-size game heap backed by the HLE heap. */
  createHeap() {
    const out = this.a(1), o = this.obj('Heap'), heap = this.h.heap;
    o.max = this.a(2); o.used = 0; o.blocks = new Map();
    o.on(5, () => {                                    // Alloc(size): fails past the size (the game probes it)
      const n = this.a(1);
      if (o.used + n > o.max) return 0;
      const p = heap.alloc(n);
      o.blocks.set(p, n); o.used += n;
      return p;
    });
    o.on(7, () => {                                    // Free(ptr)
      const p = this.a(1);
      if (o.blocks.has(p)) { o.used -= o.blocks.get(p); o.blocks.delete(p); heap.release(p); }
      return undefined;
    });
    o.on(8, () => o.used).on(9, () => o.max - o.used).on(11, () => o.max).on(12, () => o.max);
    return this.out(out, o.addr);
  }

  // --- high-level audio: MIDI songs (played by opts.onMidi; see js/midi.js) --------------
  makeMixer(o) {
    const h = this.h, a = (i) => this.a(i);
    o.on(5, () => { this.musicVolume = a(1); if (h.opts.onMidi) h.opts.onMidi('volume', null, a(1)); return OK; });
    o.on(10, () => { const dest = a(1) === o.addr ? a(0) : a(1); h.core.write(dest, new Uint8Array(12)); return dest; });
    o.on(11, () => OK);                                // SetConfig(cfg*)
    o.on(14, () => this.mixerCreateData());           // CreateAudioData(IAudioData*& out, path, flags)
    o.on(21, () => { this.mixerObs = a(1); return OK; });
  }

  mixerCreateData() {
    const h = this.h, name = h.wstr(this.a(2));
    // the game renames "N" -> "N.mid" on its first run; accept the original name too
    const bytes = h.vfs.get(name) || (name.toLowerCase().endsWith('.mid') ? h.vfs.get(name.slice(0, -4)) : null);
    if (!bytes) { h.log(`[midi] CreateAudioData(${name}) -> missing`); return E_NOT_FOUND; }
    let song;
    try { song = parseMidi(bytes); } catch (err) { h.log(`[midi] ${name}: ${err.message}`); return E_GENERIC; }
    const data = this.obj(`AudioData(${name})`);
    data.on(5, () => {                                 // CreateSound(ISound*& out)
      const snd = this.obj(`Sound(${name})`);
      snd.volume = 100;
      snd.on(5, () => { snd.volume = this.a(1); return OK; });      // SetVolume
      snd.on(7, () => OK);
      snd.on(11, () => { if (h.opts.onMidi) h.opts.onMidi('play', song, snd.volume); return OK; });   // Play
      snd.on(12, () => { if (h.opts.onMidi) h.opts.onMidi('stop', song); return OK; });               // Stop
      snd.on(13, () => Math.floor(song.duration * 1000));          // GetDuration (ms)
      snd.on(14, () => OK);                                        // repeats (0: the game replays it itself)
      return this.out(this.a(1), snd.addr);
    });
    return this.out(this.a(1), data.addr);
  }

  // --- images ---------------------------------------------------------------------------
  makeBitmap(o) {
    o.stub = false;
    o.size = [0, 0];
    o.data = 0;
    o.on(5, () => {                                    // CSize via hidden result pointer
      const dest = this.a(0) === o.addr ? this.a(1) : this.a(0);
      this.h.w32(dest, o.size[0]); this.h.w32(dest + 4, o.size[1]);
      return dest;
    });
    o.on(8, () => o.data).on(9, () => OK).on(10, () => undefined);
  }

  decodeImage() {                                      // (this, IBitmap*, data, size, mime, 0)
    const bmp = this.find(this.a(1));
    const info = this.h.core.decodeImage(this.a(2), this.a(3));
    if (!bmp || !info) { this.h.log('[img] decode failed'); return E_GENERIC; }
    bmp.size = [info.width, info.height];
    bmp.data = this.h.heap.alloc(info.width * info.height * 3);
    this.h.core.copyImage(bmp.data);
    return OK;
  }

  // --- platform file manager (ngifileaccess CFileManager, iid 0x1000301) -----------------
  makeFileManager() {
    const fm = this.obj('FileManager', 0x700, false), h = this.h;
    const root = h.allocWide(`E:\\private\\${h.opts.game.uidHex}`);
    fm.on(6, () => root);                              // private folder; games join it as "%ls\\%ls"
    fm.on(17, () => {                                  // GetFileSize(path, uint32& size)
      const data = h.vfs.get(h.wstr(this.a(1)));
      if (!data) return E_NOT_FOUND;
      return this.out(this.a(2), data.length);
    });
    fm.on(20, () => {                                  // OpenFile(path, IFile*& out, ...)
      const name = h.wstr(this.a(1));
      const data = h.vfs.get(name);
      h.log(`[fm] OpenFile(${name}) -> ${data ? 'ok' : 'missing'}`);
      if (!data) return E_NOT_FOUND;
      const f = this.obj(`File(${name})`, 0x80, false);
      f.host = new OpenFile(h.vfs, name, data, false);
      const wide = h.allocWide(name), narrow = h.allocAscii(name);
      f.on(14, () => narrow).on(19, () => wide);
      this.makeFileOps(f);
      return this.out(this.a(2), f.addr);
    });
    const driveInfo = (byIndex) => {                   // 23: GetDriveInfo(TChar drive, IDriveInfo*& out); 22: by index
      const di = this.obj(`DriveInfo(${byIndex ? 'E' : String.fromCharCode(this.a(1))})`, 0x40, true);
      di.on(9, () => {                                 // (uint64& size, uint64& free): 1 GB, 512 MB free
        h.w32(this.a(1), 0); h.w32(this.a(1) + 4, 0x40000000 / 2 ** 32 | 0);
        h.w32(this.a(1), 0x40000000); h.w32(this.a(1) + 4, 0);
        h.w32(this.a(2), 0x20000000); h.w32(this.a(2) + 4, 0);
        return OK;
      });
      return this.out(this.a(2), di.addr);
    };
    fm.on(23, () => driveInfo(false)).on(22, () => driveInfo(true));
    return fm;
  }

  makeFileOps(f) {
    const h = this.h, a = (i) => this.a(i);
    f.on(18, () => { f.observer = a(1); }).on(15, () => this.out(a(1), 2)).on(5, () => OK).on(16, () => OK);
    f.on(13, () => OK);                                // Cancel (before close)
    f.on(7, () => f.host.seek(a(1) | 0, { 0: 0, 1: 1, 2: 2 }[a(2)] ?? 0));   // Seek -> new position
    f.on(8, () => {
      const data = f.host.read(h.r32(a(2)));
      h.core.write(a(1), data);
      h.w32(a(2), data.length);
      return OK;
    });
    f.on(20, () => OK);
  }

  // --- saves ----------------------------------------------------------------------------
  savesOpen(write) {                                 // (name, mode, IFile*& out)
    const name = this.h.wstr(this.a(1)), key = '\\saves\\' + name;
    const data = this.h.vfs.get(key);
    if (!write && !data) return E_NOT_FOUND;
    const f = this.obj(`Save(${name})`, 0x80, false);
    f.host = new OpenFile(this.h.vfs, key, write ? new Uint8Array(0) : data.slice(), write);
    this.makeFileOps(f);
    if (write) {
      f.on(10, () => OK);
      f.on(11, () => { f.host.write(this.h.core.read(this.a(1), this.a(2))); return OK; });
      f.on(20, () => { f.host.close(); this.h.log(`[saves] wrote ${name}`); return OK; });
    }
    return this.out(this.a(3), f.addr);
  }

  savesGetSize() {
    const name = this.h.wstr(this.a(1));
    const data = this.h.vfs.get('\\saves\\' + name);
    if (!data) return E_NOT_FOUND;
    return this.out(this.a(2), data.length);
  }

  // --- display --------------------------------------------------------------------------
  makeDisplay() {
    const d = this.obj('Display'), a = (i) => this.a(i);
    d.on(5, () => { this.displayObs = a(1); return OK; }).on(6, () => 2);   // SetObserver
    d.on(7, () => this.out(a(2), this.obj('DisplayConfig', 0x40, true).addr));
    d.on(8, () => this.out(a(2), this.obj('Window', 0x40, true).addr));
    d.on(9, () => { this.out(a(1), 1); this.out(a(2), 1); return OK; });
    return d;
  }

  bbConfiguration() {                                  // (display, resMask, fmtMask); res& and fmt& are stack args
    const res = this.h.m.arg(4), fmt = this.h.m.arg(5), mask = this.a(3);
    [BB_RES_ID, this.bbW, this.bbH, 0, 0].forEach((v, i) => this.h.w32(res + 4 * i, v));
    const want565 = (mask & FMT_RGB565) === FMT_RGB565 && (mask & FMT_XRGB8888) !== FMT_XRGB8888;
    this.out(fmt, want565 ? FMT_RGB565 : FMT_XRGB8888);
    return OK;
  }

  bbCreate() {
    const out = this.h.m.arg(5), h = this.h, a = (i) => this.a(i);
    const bb = this.obj('BackBuffer', 0x100, false), W = this.bbW, H = this.bbH;
    bb.fmt = a(3) === FMT_RGB565 ? FMT_RGB565 : FMT_XRGB8888;
    bb.bpp = bb.fmt === FMT_RGB565 ? 2 : 4;
    bb.pixels = h.heap.alloc(W * H * 4);
    bb.res = h.heap.alloc(20);
    [BB_RES_ID, W, H, 0, 0].forEach((v, i) => h.w32(bb.res + 4 * i, v));
    bb.on(5, () => { const dest = a(0) === bb.addr ? a(1) : a(0); h.w32(dest, W); h.w32(dest + 4, H); return dest; });
    bb.on(6, () => bb.fmt).on(7, () => W * bb.bpp).on(8, () => bb.pixels).on(9, () => OK).on(10, () => undefined);
    bb.on(11, () => 0).on(13, () => this.swap()).on(14, () => OK).on(15, () => OK).on(16, () => OK);
    bb.on(17, () => OK);                               // (before GetData each frame; Brain Challenge)
    bb.on(19, () => {                                  // ConvertColor 0xRRGGBB -> buffer format
      const c = a(1);
      return bb.bpp === 4 ? c & 0xFFFFFF : ((c >> 8) & 0xF800) | ((c >> 5) & 0x7E0) | ((c >> 3) & 0x1F);
    });
    bb.on(24, () => bb.res);
    this.bb = bb;
    return this.out(out, bb.addr);
  }

  swap() {
    this.frames++;
    if (this.h.opts.onFrame) {
      const n = this.bbW * this.bbH, raw = this.h.core.read(this.bb.pixels, n * this.bb.bpp);
      this.h.opts.onFrame(this.frames, this.bb.bpp === 4 ? raw : xrgbFrom565(raw, n));
    }
    if (this.h.opts.maxFrames && this.frames >= this.h.opts.maxFrames) this.h.fail(`reached ${this.frames} frames`);
    return OK;
  }

  // --- input ----------------------------------------------------------------------------
  inputDeviceInfo() {
    const b = new Uint8Array(0x80);
    b[0] = 1; b[4] = 1;
    this.h.core.write(this.a(2), b);
    return OK;
  }

  inputCreateDevice() {
    const dev = this.obj('Keypad', 0x40, false);
    dev.on(5, () => { this.inputObs = this.a(1); });
    for (const s of [6, 7, 8, 9, 10, 11, 12, 13]) dev.on(s, () => OK);
    dev.on(22, () => { dev.observer2 = this.a(1); return OK; });   // key observer (Brain Challenge): gets the key events
    for (let s = 14; s < 22; s++) dev.on(s, () => OK);   // key-mapping setters (Brain Challenge); 19 = 0: default mapping
    this.inputDev = dev;
    return this.out(this.a(2), dev.addr);
  }

  // --- audio ----------------------------------------------------------------------------
  audioCaps() {
    const audio = this.objects.get(0x801).at(-1).addr;
    const dest = this.a(1) === audio ? this.a(0) : this.a(1);
    [10, 4, 1, 0xFFF, 0].forEach((v, i) => this.h.w32(dest + 4 * i, v));
    return dest;
  }

  audioCreateStream() {                                // (this, type, IAudioStream*& out, observer)
    const s = this.obj('AudioStream'), a = (i) => this.a(i);
    this.audioObs = a(3);
    this.audioStream = s;
    s.buf = this.h.heap.alloc(0x1000);
    s.playing = false;
    s.nextDue = 0;
    for (const k of [6, 7, 8, 9, 10, 11, 12, 14]) s.on(k, () => OK);
    s.on(13, () => { this.events.push(['audio', 0]); return OK; });
    s.on(15, () => { s.playing = true; return OK; });
    s.on(16, () => { s.playing = false; return OK; });
    s.on(17, () => { this.out(a(1), s.buf); this.out(a(2), 0x1000); return OK; });
    s.on(18, () => {
      if (this.h.opts.onAudio) this.h.opts.onAudio(this.h.core.read(s.buf, 0x1000));
      return undefined;
    });
    return this.out(a(2), s.addr);
  }

  // --- main loop pump -------------------------------------------------------------------
  methodCall(obj, slot, ...args) {
    return [this.h.r32(this.h.r32(obj) + 4 * slot), [obj, ...args]];
  }

  idleProcess() {                                      // IIdle::Process(timeoutMs, waitForEvents)
    this.nowUs += Math.max(1, this.a(1)) * 1000;
    const calls = [];
    if (this.appObs && !this.focused) { this.focused = true; calls.push(this.methodCall(this.appObs, 0)); }
    while (this.events.length) {
      const [kind, ev] = this.events.shift();
      if (kind === 'audio' && this.audioObs) calls.push(this.methodCall(this.audioObs, 0, this.audioStream.addr, ev));
      else if (kind === 'display' && this.displayObs) calls.push(this.methodCall(this.displayObs, 0, OK, this.bbW, this.bbH));
    }
    const s = this.audioStream;
    if (s && s.playing && this.nowUs >= s.nextDue) {   // one 2048-sample buffer per 92.9 ms
      s.nextDue = this.nowUs + 92880;
      calls.push(this.methodCall(this.audioObs, 0, s.addr, 4));
    }
    while (this.keyScript.length && this.keyScript[0][0] <= this.frames) {
      const [, down, bit] = this.keyScript.shift();
      this.pendingKeys.push([down, bit]);
    }
    while (this.pendingKeys.length && this.inputObs && this.inputDev && (this.pendingKeys[0][2] ?? 0) <= this.frames) {
      const [down, bit] = this.pendingKeys.shift();
      const ts = this.nowUs;
      const obs = this.inputDev.observer2 || this.inputObs;   // key events go to the key observer if set
      calls.push(this.methodCall(obs, down ? 0 : 1, this.inputDev.addr, ts >>> 0, Math.floor(ts / 2 ** 32), bit));
    }
    this.yieldIfDue();
    return this.h.runGuestCalls(calls, OK);
  }

  /** Hand control back to the page once the virtual clock reaches the scheduler's target. Called
   *  from IIdle::Process and from sleeps: some games (Block Breaker) sleep with User::AfterHighRes
   *  after each frame instead of waiting in IIdle::Process. */
  yieldIfDue() {
    if (this.nowUs >= this.targetUs) this.h.yieldRequested = true;
  }

  /** User::After / AfterHighRes: the sleep passes in virtual time. */
  sleep(us) {
    this.nowUs += us;
    this.yieldIfDue();
  }

  dlsym(lib, sym) {
    const low = lib.toLowerCase();
    if (low === 'ngifileaccess.dll' && sym === '1') {
      return this.h.syntheticFn('ngifileaccess!1', () => {   // Factory(iid, void** out)
        const iid = this.a(0);
        const o = iid === 0x1000301 ? this.makeFileManager() : this.obj(`FileAccess0x${iid.toString(16)}`);
        if (!this.objects.has(iid)) this.objects.set(iid, []);
        this.objects.get(iid).push(o);
        this.h.w32(this.a(1), o.addr);
        return OK;
      });
    }
    return 0;
  }

  register() {
    const h = this.h, a = (i) => h.a(i);
    h.on('arenaenv', 1, () => 0);
    h.on('arenaenv', 2, () => 0);
    h.on('runtime', 9, () => OK);
    h.on('runtime', 12, () => OK);
    h.on('runtime', 10, () => {
      const iid = a(0);
      if (UNSUPPORTED_IIDS.has(iid)) return E_NOT_SUPPORTED;
      const o = this.create(iid);
      if (!this.objects.has(iid)) this.objects.set(iid, []);
      this.objects.get(iid).push(o);
      h.w32(a(1), o.addr);
      return OK;
    });
    h.on('runtime', 11, () => [this.nowUs >>> 0, Math.floor(this.nowUs / 2 ** 32)]);   // 64-bit microsecond clock
    h.on('ngiutil', 8, () => OK);                      // not understood yet; called by Block Breaker, 0 is fine
    h.on('ngiutil', 19, () => OK);
    h.on('ngiutil', 14, () => a(0));
    h.on('ngiutil', 17, () => a(0));
  }
}
