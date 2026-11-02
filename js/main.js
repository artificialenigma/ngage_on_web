// Browser front end: loads the game files, runs the emulator paced to real time, draws frames,
// plays PCM through WebAudio, maps the keyboard to N-Gage keys and keeps saves in localStorage.

import { Emulator } from './emulator.js';
import { KEYS } from './ngi.js';
import { MidiPlayer } from './midi.js';

const $ = (id) => document.getElementById(id);
const canvas = $('lcd'), ctx2d = canvas.getContext('2d');
let image = ctx2d.createImageData(canvas.width, canvas.height);
const startBtn = $('start'), loadStatus = $('load-status'), status = $('status');
const picker = $('picker'), select = $('game');
// Old single-game layout (game/) has no uid/exe in files.json: that was always COTD.
const LEGACY = { title: 'Hooked On: Creatures of the Deep', uid: 0x2000AFBC, exe: 'COTD.exe' };
let SAVE_PREFIX = 'cotd-web-emu:';

const KEYMAP = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Enter: 'ok', ' ': 'ok', q: 'lsk', Q: 'lsk', F1: 'lsk', e: 'rsk', E: 'rsk', Escape: 'rsk', F2: 'rsk',
  Backspace: 'clear', '*': 'star', '#': 'hash',
  0: '0', 1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
};

// Simple dev servers (python -m http.server) reset connections under parallel load, so fetches
// retry with backoff and run at most four at a time.
async function fetchBytes(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    } catch (err) {
      if (i >= tries) throw new Error(`${url}: ${err.message}`);
      await new Promise((res) => setTimeout(res, 200 * i));
    }
  }
}

/** The prepared games (games/index.json), or the legacy single game in game/. */
async function listGames() {
  try {
    const r = await fetch('games/index.json');
    if (r.ok) return (await r.json()).map((g) => ({ ...g, dir: `games/${g.slug}/` }));
  } catch { /* fall through */ }
  return [{ ...LEGACY, slug: 'game', dir: 'game/' }];
}

async function loadAll(g) {
  const list = { ...LEGACY, ...(await (await fetch(g.dir + 'files.json')).json()) };
  const files = {};
  const jobs = [...list.sys.map((n) => ['sys/' + n, g.dir + 'sys/' + n]),
    ...list.private.map((n) => ['private/' + n, g.dir + 'private/' + n])];
  let done = 0;
  const queue = jobs.slice();
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      files[job[0]] = await fetchBytes(job[1]);
      loadStatus.textContent = `Loading game files… ${++done}/${jobs.length}`;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  // a game's own names.json lists just its imports; packages without one share the full table
  const own = g.slug === 'game' ? null : await fetch(g.dir + 'names.json');
  const names = own && own.ok ? await own.json() : await (await fetch('names.json')).json();
  const [wasm, glibBin, glibSyms] = await Promise.all([
    fetchBytes('cotd_core.wasm'),
    fetchBytes('guestlib.bin'), (await fetch('guestlib.json')).json(),
  ]);
  return { game: list, files, wasm, names, guestlib: { bin: glibBin, syms: glibSyms } };
}

// --- saves: localStorage overlay (base64), restored before boot
function storageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function storageSet(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } }
const toB64 = (b) => btoa(String.fromCharCode(...b));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function restoreSaves(vfs) {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(SAVE_PREFIX)) vfs.overlay.set(k.slice(SAVE_PREFIX.length), fromB64(localStorage.getItem(k)));
    }
  } catch { /* storage unavailable: start fresh */ }
}

// --- audio: 22050 Hz mono s16 buffers queued back to back
class Audio {
  constructor() {
    this.ctx = new AudioContext({ sampleRate: 22050 });
    this.next = 0;
  }

  push(bytes) {
    const n = bytes.length >> 1, dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const buf = this.ctx.createBuffer(1, n, 22050), ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = dv.getInt16(2 * i, true) / 32768;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    if (this.next < now + 0.02 || this.next > now + 0.5) this.next = now + 0.05;   // resync on drift
    src.start(this.next);
    this.next += buf.duration;
  }
}

let emu = null, audio = null, lastFrame = null, frames = 0, lastT = 0, statT = 0, statFrames = 0, statInsns = 0, schedUs = 0, statVirt = 0, busyMs = 0;

function draw() {
  if (!lastFrame) return;
  const src = lastFrame, dst = image.data;
  for (let i = 0, j = 0; i < src.length; i += 4, j += 4) {   // XRGB8888 little-endian -> RGBA
    dst[j] = src[i + 2]; dst[j + 1] = src[i + 1]; dst[j + 2] = src[i]; dst[j + 3] = 255;
  }
  ctx2d.putImageData(image, 0, 0);
  lastFrame = null;
}

function tick(t) {
  const dt = Math.min(100, Math.max(0, t - lastT));          // cap catch-up after tab switches
  lastT = t;
  // Advance a scheduler clock by exactly the real time elapsed. Targeting nowUs + dt instead
  // would compound the guest's overshoot past each target and run the game ~20% fast.
  schedUs = Math.max(schedUs + dt * 1000, emu.ngi.nowUs - 100000);
  const t0 = performance.now();
  const alive = emu.runUntil(schedUs);
  busyMs += performance.now() - t0;
  draw();
  if (t - statT > 1000) {
    const insns = emu.core.executed(), span = t - statT;
    status.textContent = `${Math.round((frames - statFrames) * 1000 / span)} fps · ` +
      `game speed ${((emu.ngi.nowUs - statVirt) / 1000 / span).toFixed(2)}× · ` +
      `${((insns - statInsns) / span / 1000).toFixed(0)} MIPS · CPU busy ${Math.round(100 * busyMs / span)}% · ` +
      `JIT ${emu.core.jitBlocks()} blocks`;
    statT = t; statFrames = frames; statInsns = insns; statVirt = emu.ngi.nowUs; busyMs = 0;
  }
  if (alive) requestAnimationFrame(tick);
  else status.textContent = `Stopped: ${emu.stopReason}`;
}

function sendKey(name, down) {
  if (emu && KEYS[name] !== undefined) emu.key(down, KEYS[name]);
}

window.addEventListener('keydown', (e) => {
  const k = KEYMAP[e.key];
  if (!k) return;
  e.preventDefault();
  if (!e.repeat) sendKey(k, true);
});
window.addEventListener('keyup', (e) => {
  const k = KEYMAP[e.key];
  if (!k) return;
  e.preventDefault();
  sendKey(k, false);
});
for (const b of document.querySelectorAll('#softkeys button')) {
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); sendKey(b.dataset.key, true); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => sendKey(b.dataset.key, false));
}

startBtn.disabled = true;
let assets = null;
(async () => {
  const games = await listGames();
  const want = new URLSearchParams(location.search).get('game');
  const g = games.find((x) => x.slug === want) || games.find((x) => x.uid === LEGACY.uid) || games[0];
  for (const x of games) {
    const label = x.status && x.status !== 'ok' ? `${x.title} (${x.status})` : x.title;
    select.add(new Option(label, x.slug, false, x === g));
  }
  picker.hidden = games.length < 2;
  select.addEventListener('change', () => { location.search = '?game=' + encodeURIComponent(select.value); });
  document.title = g.title;
  // COTD keeps its original save key so existing saves survive; other games get their own.
  if (g.uid !== LEGACY.uid) SAVE_PREFIX = `ngage-web-emu:${g.slug}:`;
  assets = await loadAll(g);
  startBtn.disabled = false;
  loadStatus.textContent = 'Click to start (sound needs a click)';
})().catch((err) => {
  loadStatus.textContent = `Could not load the game files: ${err.message}. Run port/tools/prepare_web.py first.`;
});

startBtn.addEventListener('click', async () => {
  if (!assets || emu) return;
  startBtn.classList.add('hidden');
  try { audio = new Audio(); } catch { audio = null; }
  const music = audio ? new MidiPlayer(audio.ctx) : null;
  emu = await Emulator.create({
    ...assets,
    opts: {
      onFrame: (n, px) => { lastFrame = px; frames = n; },
      onAudio: (pcm) => { if (audio) audio.push(pcm); },
      onMidi: (what, song, volume) => {
        if (!music) return;
        if (what === 'play') music.play(song, volume);
        else if (what === 'stop') music.stop();
        else if (what === 'volume') music.setVolume(volume);
      },
      onWrite: (k, data) => storageSet(SAVE_PREFIX + k, data ? toB64(data) : null),
      log: null,
    },
  });
  restoreSaves(emu.vfs);
  if (emu.ngi.bbW !== canvas.width) {                // portrait games
    canvas.width = emu.ngi.bbW;
    canvas.height = emu.ngi.bbH;
    canvas.parentElement.classList.toggle('portrait', emu.ngi.bbH > emu.ngi.bbW);
    image = ctx2d.createImageData(canvas.width, canvas.height);
  }
  canvas.focus();
  lastT = statT = performance.now();
  requestAnimationFrame(tick);
});
