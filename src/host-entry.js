// Chain SDK <-> joyplay ExternalResultsApiV1 bridge — browser entry point.
//
// The actual game (loaded in the nested iframe, straight from joyplay's own
// server, completely unmodified) speaks a small postMessage protocol,
// externalResultsApiV1.js, requiring only `ready`/`balance`/`play`/`endPlay`
// handlers that hand back a plain {balance,currency} or {amountWon} — no
// seed, no reel/cosmetic concerns at all; the game constructs its own
// matching visual result internally from just that number. See
// ~/.claude/plans/goofy-puzzling-trinket.md for the full writeup of why
// (container=external mode, getClosestResultThatPays).
//
// This script implements those handlers by opening/watching real sessions
// on the Chain SDK host via Penpal — the same connection pattern the
// previous (now removed) chain-host-shim.js used for the old Stake Engine
// integration, just driving different handlers.
import { WindowMessenger, connect } from 'penpal';
import { createExternalBridge } from './external-bridge.js';

const getAllowedParentOrigins = () => {
  if (typeof document === 'undefined' || !document.referrer) return ['*'];
  try {
    return [new URL(document.referrer).origin];
  } catch {
    return ['*'];
  }
};

// Testing hook: real wins are rare, and the game's own bonus-wheel visual is
// incidental to whatever seed its internal table associates with the
// requested multiplier — not something we can request directly. Add
// `?debugForce=amount:5` to the page URL to make every spin resolve
// immediately at 5x the bet (bypassing the real contract entirely), so the
// game's own rendering can be exercised with arbitrary multipliers without
// waiting on rare real triggers or spending real gas/VRF round-trips.
function parseDebugForceMultiplier() {
  const raw = new URLSearchParams(window.location.search).get('debugForce');
  const match = raw && /^amount:([\d.]+)$/.exec(raw);
  return match ? Number(match[1]) : null;
}
const debugForceMultiplier = parseDebugForceMultiplier();
if (debugForceMultiplier != null) {
  console.info(
    '[external-bridge] debugForce active — every spin resolves immediately at',
    debugForceMultiplier,
    'x bet, bypassing the real contract. Remove ?debugForce=... from the URL to play for real.',
  );
}

const bridge = createExternalBridge(
  methods =>
    connect({
      messenger: new WindowMessenger({
        remoteWindow: window.parent,
        allowedOrigins: getAllowedParentOrigins(),
      }),
      methods,
    }),
  { debugForceMultiplier },
);

window.initAPI({
  gameIframeId: 'gameIFrame',
  ready: bridge.ready,
  balance: bridge.balance,
  play: bridge.play,
  endPlay: bridge.endPlay,
});
// The game occasionally asks for a balance refresh under commandType
// "BALANCE_UPDATE" rather than "balance" (confirmed by reading the game
// bundle directly) — externalResultsApiV1.js's own initAPI never wires that
// commandType up, so alias it here.
window.addRequestHandler('BALANCE_UPDATE', bridge.balance);
