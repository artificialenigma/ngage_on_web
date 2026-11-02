# Hooked On: Creatures of the Deep — browser player (open-source edition)

A browser player for N-Gage 2.0 games. It runs a game's original ARM code: a small emulator recreates the phone's CPU
and the parts of the phone's system the games need. Everything runs locally; nothing is uploaded.

It was built for *Hooked On: Creatures of the Deep* (Infinite Dreams / Nokia, 2008) and also plays *Block Breaker
Deluxe* (Gameloft, 2008). Other N-Gage 2.0 games can be added and show up in the game list, marked "untested": some
will need more of the phone emulated before they run.

**This folder contains no game files.** You need your own copies of the games and add them once (see below).

## What you need

- **Your own copies of the games**, installed somewhere this tool can read the files. The easiest way is to install them in
  the [EKA2L1](https://github.com/EKA2L1/EKA2L1) Symbian emulator, using its Nokia 5320 (S60 3rd FP2) profile with the
  N-Gage 2.0 app.
- **Python 3**, used to set up the game files and to serve this folder to your browser. Windows: install it from
  python.org and tick "Add Python to PATH".
- **A current browser**: Chrome, Edge, Firefox or Safari.

## Add your games (once)

The player needs the files the N-Gage installer puts on the phone: each game's `Sys/Bin/<game>.exe` with its own DLLs,
and its `Private/<uid>/` data folder (for Hooked On: `COTD.exe`, `BiNPDAlibcCOTD.dll`,
`ngifilemanagerfactory_2000afbc.dll` and `Private/2000AFBC/`).

Open a terminal in this folder and run:

```
python3 tools/setup_game.py
```

- **With no folder given,** it searches EKA2L1's usual data locations: macOS `~/Library/Application Support/EKA2L1`, Linux
  `~/.local/share/EKA2L1`, Windows `%APPDATA%\EKA2L1`.
- **For anywhere else,** give the folder that contains the installed games, for example `python3 tools/setup_game.py "D:\EKA2L1"`.
  It searches subfolders, so pointing at the emulator's data folder is enough.

It finds every installed N-Gage 2.0 game, copies what each needs into `games/<name>/`, unpacks the executables into the
form the browser loader expects, and lists what it found. Run it again any time to add or refresh games.

## Start the game

The game must be opened through the small local server. Opening `index.html` directly from the file system does not
work.

**macOS:** double-click `start.command`.
- The first time, macOS may refuse to open it. In that case, right-click the file, choose **Open**, then **Open** again.
- If it then says it can't run, open Terminal, type `chmod +x ` (with a space), drag `start.command` into the window, and press Enter.

**Windows:** double-click `start.bat`.

**Linux:** run `./start.sh` in a terminal.

**Any system, by hand:** open a terminal in this folder and run:

```
python3 tools/serve.py 8765
```

Then open http://localhost:8765.

Pick the game in the **Game** list above the screen, then click **Start**. The click is also what allows the browser
to play sound. Keep the terminal window open while you play; closing it stops the server.

## Controls

| Phone key | Keyboard |
|---|---|
| Up / Down / Left / Right | Arrow keys |
| OK (centre key) | Enter or Space |
| Left soft key (label at bottom left, e.g. SELECT) | Q (or F1) |
| Right soft key (bottom right, e.g. EXIT / BACK) | E, Esc (or F2) |
| Clear | Backspace |
| Number keys 0–9 | 0–9 |
| * and # | * and # |

The buttons under the screen do the same for the soft keys and OK, with mouse or touch.
- **Hooked On:** on the map, press **5** to drop anchor and start fishing.
- **Block Breaker Deluxe:** choose **YES** at the start (Left, then Enter) for music; **5** launches the ball.

## Saves

The games save automatically. Each game keeps its own saves in your browser's storage for `localhost:8765`, so:
- they survive closing the browser;
- they are per browser;
- clearing site data for localhost deletes them.

## The status line

`32 fps · game speed 1.00× · 130 MIPS · CPU busy 12% · JIT 10000 blocks`:
- **fps:** frames per second (Hooked On runs at 32, Block Breaker at 20).
- **game speed:** 1.00× means real time; loading screens can dip briefly.
- **MIPS:** millions of ARM instructions emulated per second.
- **CPU busy:** how much of each frame the emulator needs.
- **JIT blocks:** pieces of game code translated to WebAssembly so far.

## Troubleshooting

- **"Could not load the game files":** run `python3 tools/setup_game.py` first, or you opened `index.html` directly.
- **Setup can't find a game:** make sure the game is installed (not just the `.n-gage` file copied). Then point the script at the
  folder containing its `Private/<uid>` and `Sys/Bin`.
- **A game marked "untested" stops or shows a black screen:** it needs parts of the phone the player doesn't emulate yet.
  The status line under the screen says where it stopped.
- **Port 8765 busy:** start with `python3 tools/serve.py 8770` and open http://localhost:8770. Saves are per port.
- **No sound:** click **Start**, and check the tab isn't muted.
- **Keys do nothing:** click on the game screen once to give the page keyboard focus.

## Known limits

- Hooked On's main menu may show **"Trial version"**, depending on the licence state of your copy. Instant Play works;
  "Purchase Game" needs Nokia's long-closed online store.
- N-Gage online features (Arena rankings etc.), vibration and the text-entry keyboard are not emulated.
- **Encrypted game files:** N-Gage games shipped some data under Nokia's DRM, unlocked on the phone by a key from the
  store. Where a copy still has such a file, the player can't read it. For Block Breaker that is the sound effects
  (the player substitutes silence; the music works through a simple built-in synthesiser). Other games may need a
  locked file to run at all. `tools/compat.py` lists the fixes the player knows about.
- **Brain Challenge** starts but stops at the N-Gage logo.

## How it works / building from source

| Path | What |
|---|---|
| `cotd_core.wasm` | Prebuilt CPU emulator: an ARMv5TE + Thumb interpreter, an ARM → WebAssembly block JIT, and PNG/JPEG decoding |
| `source/core/` | Its Rust source |
| `js/` | The platform layer: E32 loader and relocation, Symbian libc/euser/efsrv and N-Gage (NGI) interfaces, virtual file system, MIDI synthesiser, page |
| `guestlib.bin/.json` | Small native ARM helpers; source in `source/guestlib.s` |
| `names.json` | Symbian export-ordinal names for the phone libraries the player provides |
| `games/` | Your games, added by `tools/setup_game.py` |
| `tools/` | The server, the game setup script (`compat.py`: per-game fixes; `e32/` unpacks Symbian executables), and a headless runner |

**Rebuild the emulator** (needs Rust with the `wasm32-unknown-unknown` target):

```
cd source/core && cargo build --release --target wasm32-unknown-unknown
```

Then copy `target/wasm32-unknown-unknown/release/cotd_core.wasm` over the one in this folder.

**Rebuild the ARM helpers** (needs clang with an ARM target, run from this folder):

```
python3 source/build_guestlib.py
```

That writes `guestlib.bin/.json` next to it; copy them here.

**Run headless** (needs Node):

```
node tools/run_node.mjs --game hooked-on-creatures-of-the-deep --frames 400
```

`--game` takes a folder name from `games/`. Add `--no-jit` to compare against the interpreter.

## Credits and licences

- **Player code:** MIT License, see `LICENSE`.
- **`names.json`:** derived from Symbian Foundation `.def` export tables (Eclipse Public License).
- **Image decoding in the core:** the Rust crates `png` and `jpeg-decoder` (MIT / Apache-2.0).
- **The games** (*Hooked On: Creatures of the Deep* © Infinite Dreams / Nokia, *Block Breaker Deluxe* © Gameloft,
  and others): not included; use your own copies.
