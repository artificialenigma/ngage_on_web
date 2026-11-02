# HOCTD-opensource: an N-Gage 2.0 player for the browser

A browser player for Nokia N-Gage 2.0 games that runs a game's **original ARM code**. A small emulator recreates the phone's
CPU, and high-level stubs stand in for the parts of Symbian and the N-Gage platform the games call. Everything runs
locally in your browser.

**No games are included.** You add your own installed copies with one command.

## Game support

| Game | Status |
|---|---|
| Hooked On: Creatures of the Deep (Infinite Dreams / Nokia) | Plays, with sound |
| Block Breaker Deluxe (Gameloft) | Plays, with music (sound effects are DRM-locked, so silent) |
| Brain Challenge (Infinite Dreams / Nokia) | Starts, stops at the N-Gage logo |
| Other N-Gage 2.0 games | Untested: most will need more of the phone emulated |

## Quick start

1. **Install your games** in the [EKA2L1](https://github.com/EKA2L1/EKA2L1) emulator, using its Nokia 5320 profile with
   the N-Gage 2.0 app, or have their installed files somewhere on disk.
2. **Add them to the player:**
   ```
   python3 tools/setup_game.py              # searches EKA2L1's data folder
   python3 tools/setup_game.py "D:\EKA2L1"  # or any folder that contains installed games
   ```
3. **Start the player:** `start.command` (macOS), `start.bat` (Windows) or `./start.sh` (Linux). Then pick a game at
   http://localhost:8765 and click **Start**.

[INSTRUCTIONS.md](INSTRUCTIONS.md) has controls, saves, troubleshooting and build steps.

## How it works

| Part | What |
|---|---|
| `cotd_core.wasm` (`source/core/`) | ARMv5TE + Thumb interpreter with an ARM → WebAssembly block JIT, written in Rust |
| `js/machine.js`, `js/hle.js` | E32 image loader and relocation; trap dispatch from imported functions to JavaScript |
| `js/libc.js`, `js/euser.js` | P.I.P.S. libc and Symbian euser/efsrv stubs |
| `js/ngi.js` | The N-Gage platform interfaces: display, back buffer, input, audio, saves, files, fonts, memory |
| `js/midi.js` | MIDI parser and a small WebAudio synthesiser for game music |
| `guestlib.*` (`source/guestlib.s`) | A few native ARM helpers the games call |
| `tools/setup_game.py`, `tools/compat.py` | Finds installed games and copies them in, with per-game fixes for known DRM leftovers |

The games' own DLLs (their libc shims and DRM file managers) run natively. The phone's system libraries are
emulated.

## Building from source

- **Emulator core:** `cd source/core && cargo build --release --target wasm32-unknown-unknown`, then copy
  `cotd_core.wasm` here.
- **ARM helpers:** `python3 source/build_guestlib.py` (needs clang with an ARM target).
- **Headless test run:** `node tools/run_node.mjs --game <folder in games/> --frames 400`.

## Licence

The player code is under the MIT License (see [LICENSE](LICENSE)). `names.json` is derived from Symbian Foundation `.def`
export tables (EPL). The games are © their publishers and are not included.
