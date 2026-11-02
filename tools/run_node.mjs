// Headless runner: boots the browser build in Node, replays a key script, saves PNG frames.
// Usage: node tools/run_node.mjs --frames 1600 --save-every 20 --keys "300:ok,420:lsk" --out /tmp/frames
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { Emulator } from '../js/emulator.js';
import { KEYS } from '../js/ngi.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..');
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const maxFrames = +opt('frames', 400), saveEvery = +opt('save-every', 0), outDir = opt('out', null), wavPath = opt('wav', null);
const pcm = [], midi = [];
const keys = (opt('keys', '') || '').split(',').filter(Boolean).flatMap((s) => {
  const [f, k] = s.split(':');
  return [[+f, true, KEYS[k]], [+f + 3, false, KEYS[k]]];
}).sort((x, y) => x[0] - y[0]);

function png(w, h, rgba) {
  const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = crcTable[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y * w + x) * 4, d = y * (w * 3 + 1) + 1 + x * 3;
    raw[d] = rgba[s + 2]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s];       // XRGB8888 (LE) -> RGB
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// --game <slug> picks a prepared game (games/<slug>); default: COTD, or the legacy game/ folder.
const slug = opt('game', 'hooked-on-creatures-of-the-deep');
const gameDir = fs.existsSync(path.join(WEB, 'games', slug)) ? path.join(WEB, 'games', slug) : path.join(WEB, 'game');
const list = { title: 'Hooked On: Creatures of the Deep', uid: 0x2000AFBC, exe: 'COTD.exe',
  ...JSON.parse(fs.readFileSync(path.join(gameDir, 'files.json'))) };
const namesPath = fs.existsSync(path.join(gameDir, 'names.json')) ? path.join(gameDir, 'names.json') : path.join(WEB, 'names.json');
const files = {};
for (const n of list.sys) files['sys/' + n] = new Uint8Array(fs.readFileSync(path.join(gameDir, 'sys', n)));
for (const n of list.private) files['private/' + n] = new Uint8Array(fs.readFileSync(path.join(gameDir, 'private', n)));
if (outDir) fs.mkdirSync(outDir, { recursive: true });

const emu = await Emulator.create({
  wasm: fs.readFileSync(path.join(WEB, 'cotd_core.wasm')),
  game: list,
  files,
  names: JSON.parse(fs.readFileSync(namesPath)),
  guestlib: { bin: new Uint8Array(fs.readFileSync(path.join(WEB, 'guestlib.bin'))), syms: JSON.parse(fs.readFileSync(path.join(WEB, 'guestlib.json'))) },
  opts: {
    maxFrames,
    jit: !argv.includes('--no-jit'),
    log: process.env.VERBOSE ? (s) => console.log('  ' + s) : null,
    onAudio: (b) => { if (wavPath) pcm.push(Buffer.from(b)); },
    onMidi: (what, song) => { if (what === 'play') midi.push(`${song.duration.toFixed(1)}s@${emu?.ngi.frames}`); },
    onFrame: (n, px) => {
      if (outDir && saveEvery && n % saveEvery === 0) {
        fs.writeFileSync(path.join(outDir, `frame_${String(n).padStart(5, '0')}.png`), png(emu.ngi.bbW, emu.ngi.bbH, px));
      }
    },
  },
});
emu.ngi.keyScript = keys;
const t0 = performance.now();
while (emu.runUntil(Infinity)) { /* runs to completion: targetUs = Infinity never yields */ }
const ms = performance.now() - t0;
console.log(`stop: ${emu.stopReason}`);
if (midi.length) console.log(`music: ${midi.length} songs started (${midi.slice(0, 8).join(', ')})`);
if (wavPath) {
  const data = Buffer.concat(pcm), hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVEfmt ', 8); hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(22050, 24); hdr.writeUInt32LE(44100, 28);
  hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
  fs.writeFileSync(wavPath, Buffer.concat([hdr, data]));
  console.log(`audio: ${pcm.length} buffers, ${(data.length / 2 / 22050).toFixed(1)} s -> ${wavPath}`);
}
console.log(`virtual time: ${(emu.ngi.nowUs / 1e6).toFixed(1)} s, jit blocks: ${emu.core.jitBlocks()}` +
  (emu.core.jitErrors ? `, jit errors: ${emu.core.jitErrors.join(' | ')}` : ''));
console.log(`frames=${emu.ngi.frames} insns=${(emu.core.executed() / 1e6).toFixed(0)}M time=${(ms / 1000).toFixed(1)}s ` +
  `MIPS=${(emu.core.executed() / ms / 1000).toFixed(0)}`);
