# happydaze — Chain SDK integration

A thin host page that bridges joyplay's "happydaze" slot game to a Chain SDK
casino contract. The game itself is never modified, forked, or self-hosted —
it runs unmodified on joyplay's own server, in its officially-supported
`container=external` mode, and only ever receives a single settled
`amountWon` figure per spin. Our contract, `HappydazeSlots.sol`, is the sole
source of truth for what that figure is.

## How it fits together

```
index.html (this repo, served statically)
  ├─ externalResultsApiV1.js   — joyplay's small postMessage RPC library (unmodified)
  ├─ assets/index-host.js      — our bridge, built from src/
  └─ <iframe src="https://dev.joyplay.com/spinsandwins/index.html?container=external&...">
       — the real game, loaded live from joyplay's server, untouched

index.html is itself loaded in an iframe by a Chain SDK host (the local
simulator during development, or the production Chain.wtf host) — so it sits
in the middle: postMessage down to the joyplay game, Penpal up to the Chain
SDK host.
```

- **`src/host-entry.js`** — browser wiring. Opens a Penpal connection to
  `window.parent` (the Chain SDK host) and registers `ready`/`balance`/
  `play`/`endPlay` handlers with `externalResultsApiV1.js`'s `initAPI(...)`.
  Also aliases the game's occasional `BALANCE_UPDATE` balance-refresh
  request (which the reference library doesn't wire up by default), and
  implements a `?debugForce=amount:N` test hook that makes every spin
  resolve instantly at `N` times the bet, bypassing the real contract —
  useful for exercising rare outcomes (like the jackpot ladder) without
  waiting on real odds.
- **`src/external-bridge.js`** — the actual logic, kept free of any
  browser/Penpal specifics so it's unit-testable with a fake host
  connection (see `test/external-bridge.test.mjs`). `play()` opens a real
  session on the contract, waits for it to settle (transparently, whether
  that takes one randomness callback or more), and reports the payout.
- **`contracts/HappydazeSlots.sol`** — the on-chain paytable, implementing
  `ICasinoGameV2`. See the contract's own header comment for the full
  design writeup; in short:
  - 48 base tiers taken directly from the game's real in-game paytable
    (0.1x up to 20x, including the 6th-reel bonus tiers), each equally
    likely, diluted by a no-win bucket sized to hit a 96% target RTP.
  - A MINI/MINOR/MAJOR jackpot ladder (100x/250x/1000x), matching the
    game's own in-game bonus wheel, added as a rare additive layer on top
    (~1-in-11k/114k/1.14M), so that visible feature is actually winnable.
  - Total realised RTP ≈ 97.18%.

## Local development

### 1. Run the Chain SDK simulator

From the `@chain/casino-sdk` package (a separate checkout — see its own
`docs/LOCAL_SIMULATOR.md`):

```sh
npm install
npm start   # local chain + VRF node + deployment + harness (:3300)
```

Drop `contracts/HappydazeSlots.sol` (and `ICasinoGameV2.sol`) into that
package's `simulator/contracts/` — the local node watches the folder and
auto-compiles/deploys/registers it within a couple of seconds, printing the
deployed address to its log.

### 2. Serve this repo statically

```sh
python3 -m http.server 8787
```

A plain `http.server` works for basic testing, but the simulator's own UI
fetches `game.manifest.json` cross-origin and will hit a CORS error unless
the server sends `Access-Control-Allow-Origin`. Use any static server that
sets that header (or a small wrapper subclassing
`http.server.SimpleHTTPRequestHandler`) for a clean console.

### 3. Build the host bridge

```sh
npm install
npm run build:host   # esbuild src/host-entry.js -> assets/index-host.js
```

Re-run this after editing `src/host-entry.js` or `src/external-bridge.js`.

### 4. Open the simulator against this game

```
http://localhost:3300/?game=http://localhost:8787&gameAddress=0x<deployed address>
```

Add `&debugForce=amount:100` (etc.) to the *inner* game URL query — i.e. set
it via the simulator's game-URL field as
`http://localhost:8787/index.html?debugForce=amount:100` — to force every
spin to resolve at a specific multiplier for testing.

## Tests

```sh
node --test test/external-bridge.test.mjs
```

Exercises `src/external-bridge.js` end-to-end (ready/balance/play/endPlay)
against a mocked Chain SDK host — no browser needed.
