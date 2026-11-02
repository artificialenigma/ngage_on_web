// Standard MIDI files: a parser (also used by the HLE for song durations) and a small WebAudio
// synthesiser that stands in for the phone's MIDI engine. Voices are simple waveforms chosen by
// General MIDI instrument family; channel 10 is drums (noise and sine sweeps).

/** -> { duration (s), notes: [{ t, dur, ch, note, vel, prog, vol }] } with times in seconds. */
export function parseMidi(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (p) => String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
  if (tag(0) !== 'MThd') throw new Error('not a MIDI file');
  const ntrk = dv.getUint16(10), div = dv.getUint16(12);
  if (div & 0x8000) throw new Error('SMPTE time division not supported');
  const events = [];                                   // [tick, order, kind, a, b, c]
  let pos = 8 + dv.getUint32(4), order = 0;
  for (let t = 0; t < ntrk && tag(pos) === 'MTrk'; t++) {
    const end = pos + 8 + dv.getUint32(pos + 4);
    let p = pos + 8, tick = 0, status = 0;
    const varlen = () => { let v = 0, b; do { b = bytes[p++]; v = (v << 7) | (b & 0x7F); } while (b & 0x80); return v; };
    while (p < end) {
      tick += varlen();
      if (bytes[p] & 0x80) status = bytes[p++];
      const hi = status & 0xF0, ch = status & 0x0F;
      if (status === 0xFF) {
        const type = bytes[p++], len = varlen();
        if (type === 0x51 && len === 3) events.push([tick, order++, 'tempo', (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2]]);
        p += len;
      } else if (status === 0xF0 || status === 0xF7) {
        p += varlen();
      } else if (hi === 0x80 || hi === 0x90) {
        const note = bytes[p], vel = bytes[p + 1];
        p += 2;
        events.push([tick, order++, hi === 0x90 && vel ? 'on' : 'off', ch, note, vel]);
      } else if (hi === 0xB0) { events.push([tick, order++, 'ctl', ch, bytes[p], bytes[p + 1]]); p += 2; }
      else if (hi === 0xC0) { events.push([tick, order++, 'prog', ch, bytes[p]]); p += 1; }
      else if (hi === 0xA0 || hi === 0xE0) p += 2;
      else if (hi === 0xD0) p += 1;
      else throw new Error(`bad MIDI status 0x${status.toString(16)}`);
    }
    pos = end;
  }
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  let tempo = 500000, lastTick = 0, sec = 0;
  const prog = new Array(16).fill(0), vol = new Array(16).fill(100), expr = new Array(16).fill(127);
  const open = new Map(), notes = [];
  for (const [tick, , kind, a, b, c] of events) {
    sec += (tick - lastTick) * tempo / div / 1e6;
    lastTick = tick;
    if (kind === 'tempo') tempo = a;
    else if (kind === 'prog') prog[a] = b;
    else if (kind === 'ctl') { if (b === 7) vol[a] = c; else if (b === 11) expr[a] = c; }
    else {
      const key = a * 128 + b, started = open.get(key);
      if (started) { started.dur = Math.max(0.02, sec - started.t); open.delete(key); }
      if (kind === 'on') {
        const n = { t: sec, dur: 0.5, ch: a, note: b, vel: c / 127, prog: prog[a], vol: (vol[a] / 127) * (expr[a] / 127) };
        notes.push(n);
        open.set(key, n);
      }
    }
  }
  return { duration: sec, notes };
}

// GM family -> [oscillator type, attack s, release s, level]
function voice(prog) {
  if (prog < 8) return ['triangle', 0.005, 0.25, 0.9];          // piano
  if (prog < 16) return ['sine', 0.002, 0.4, 0.8];              // chromatic percussion
  if (prog < 24) return ['square', 0.02, 0.1, 0.35];            // organ
  if (prog < 32) return ['sawtooth', 0.005, 0.15, 0.35];        // guitar
  if (prog < 40) return ['triangle', 0.005, 0.1, 1.0];          // bass
  if (prog < 56) return ['sawtooth', 0.08, 0.3, 0.3];           // strings / ensemble
  if (prog < 80) return ['square', 0.02, 0.1, 0.3];             // brass / reed / pipe
  if (prog < 88) return ['square', 0.005, 0.1, 0.3];            // synth lead
  if (prog < 96) return ['sawtooth', 0.15, 0.4, 0.25];          // synth pad
  return ['triangle', 0.01, 0.2, 0.5];
}

export class MidiPlayer {
  constructor(ctx) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.3;
    this.out.connect(ctx.destination);
    this.song = null;
    this.bus = null;
    this.noise = null;
  }

  /** Master volume 0..100 (the game's mixer volume). */
  setVolume(v) { this.out.gain.value = 0.6 * Math.max(0, Math.min(100, v)) / 100; }

  stop() {
    if (this.bus) {
      const bus = this.bus, t = this.ctx.currentTime;
      bus.gain.setTargetAtTime(0, t, 0.02);
      setTimeout(() => bus.disconnect(), 300);
    }
    this.bus = null;
    this.song = null;
  }

  play(song, volume = 100) {
    this.stop();
    const ctx = this.ctx, bus = ctx.createGain(), t0 = ctx.currentTime + 0.05;
    bus.gain.value = volume / 100;
    bus.connect(this.out);
    this.bus = bus;
    this.song = song;
    for (const n of song.notes) {
      const t = t0 + n.t, amp = 0.25 * n.vel * n.vol;
      if (n.ch === 9) this.drum(bus, n.note, t, amp);
      else this.tone(bus, n, t, amp);
    }
  }

  tone(bus, n, t, amp) {
    const ctx = this.ctx, [type, att, rel, lvl] = voice(n.prog);
    const osc = ctx.createOscillator(), env = ctx.createGain();
    osc.type = type;
    osc.frequency.value = 440 * 2 ** ((n.note - 69) / 12);
    const peak = amp * lvl, end = t + n.dur;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + att);
    env.gain.setValueAtTime(peak, Math.max(t + att, end));
    env.gain.exponentialRampToValueAtTime(0.0001, Math.max(t + att, end) + rel);
    osc.connect(env).connect(bus);
    osc.start(t);
    osc.stop(Math.max(t + att, end) + rel + 0.05);
  }

  noiseBuffer() {
    if (!this.noise) {
      const n = this.ctx.sampleRate, buf = this.ctx.createBuffer(1, n, n), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
    }
    return this.noise;
  }

  drum(bus, note, t, amp) {
    const ctx = this.ctx, env = ctx.createGain();
    env.connect(bus);
    if (note === 35 || note === 36) {                                // bass drum: falling sine
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(120, t);
      osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      env.gain.setValueAtTime(amp * 2.2, t);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      osc.connect(env);
      osc.start(t);
      osc.stop(t + 0.3);
      return;
    }
    const src = ctx.createBufferSource(), filt = ctx.createBiquadFilter();
    src.buffer = this.noiseBuffer();
    const hat = note === 42 || note === 44 || note === 46 || note >= 49;   // hi-hats and cymbals
    filt.type = hat ? 'highpass' : 'bandpass';
    filt.frequency.value = hat ? 7000 : 1800;
    const len = note === 46 || note >= 49 ? 0.3 : hat ? 0.05 : 0.15;
    env.gain.setValueAtTime(amp * (hat ? 0.5 : 1.2), t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src.connect(filt).connect(env);
    src.start(t, Math.random() * 0.5);
    src.stop(t + len + 0.02);
  }
}
