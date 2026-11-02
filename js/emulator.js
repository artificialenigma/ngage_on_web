// Wires the wasm core, loader and HLE together. Used by the browser page and the Node runner.

import { Core } from './core.js';
import { Machine } from './machine.js';
import { HLE, RET_TRAP } from './hle.js';
import { VFS } from './vfs.js';

export class Emulator {
  /**
   * @param {object} p
   * @param {Uint8Array} p.wasm      cotd_core.wasm
   * @param {object} p.game          the game's files.json: { title, uid, exe, sys, private }
   * @param {object} p.files         { 'sys/COTD.exe': Uint8Array, ..., 'private/data0000.pak': ... }
   * @param {object} p.names         names.json
   * @param {object} p.guestlib      { bin: Uint8Array, syms: guestlib.json }
   * @param {object} p.opts          { onFrame, onAudio, log, maxFrames, onWrite }
   */
  static async create(p) {
    const core = await Core.fromBytes(p.wasm);
    const privateFiles = {};
    for (const [k, v] of Object.entries(p.files)) if (k.startsWith('private/')) privateFiles[k.slice(8)] = v;
    const game = { ...p.game, uidHex: (p.game.uid >>> 0).toString(16).padStart(8, '0') };
    const vfs = new VFS(privateFiles, game.uidHex, p.opts.onWrite);
    let hle = null;
    const machine = new Machine(core, game, p.files, p.guestlib, (m) => {
      hle = new HLE(m, { names: p.names, game, ...p.opts });
      hle.vfs = vfs;
      return hle;
    });
    hle.boot();
    if (p.opts.jit !== false) core.enableJit();
    return new Emulator(core, machine, hle, vfs);
  }

  constructor(core, machine, hle, vfs) {
    this.core = core;
    this.machine = machine;
    this.hle = hle;
    this.vfs = vfs;
    this.done = false;
  }

  get ngi() { return this.hle.ngi; }
  get stopReason() { return this.machine.stopReason; }

  /** Run until the virtual clock reaches `targetUs` (or the guest stops). Returns false once stopped. */
  runUntil(targetUs) {
    if (this.done) return false;
    if (this.ngi.nowUs >= targetUs) return true;          // ahead of real time: let the page catch up
    this.ngi.targetUs = targetUs;
    const r = this.machine.run(RET_TRAP, 0);
    if (r === 'stopped' || r === 'until') {
      this.done = true;
      if (r === 'until' && !this.machine.stopReason) this.machine.stopReason = 'game returned from main';
      return false;
    }
    return true;
  }

  key(down, bit) { this.ngi.key(down, bit); }
}


