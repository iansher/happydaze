// Drives the actual host bridge logic (src/external-bridge.js) through a
// full ExternalResultsApiV1 flow — ready, play (win + loss), endPlay —
// against a mocked Chain SDK host, with exact assertions on every response
// shape and unit conversion. No browser needed: this is plain business
// logic with Penpal's `connect` swapped for a test double.
import assert from 'node:assert/strict';
import { createExternalBridge, toBaseUnits, toHumanNumber } from '../src/external-bridge.js';

const DECIMALS = 18;
const UNIT = 10n ** BigInt(DECIMALS);

function humanBalanceToBase(human) {
  return ((BigInt(Math.round(human * 1000)) * UNIT) / 1000n).toString();
}

function makeFakeHost() {
  let setStateFn = null;
  const openSessionCalls = [];
  const revealOutcomeCalls = [];
  let counter = 0;
  const hostApi = {
    async openSession(input) {
      openSessionCalls.push(input);
      return { sessionKey: `31337:${++counter}`, transactionHash: '0xtx' };
    },
    async revealOutcome({ sessionId }) {
      revealOutcomeCalls.push(sessionId);
    },
  };
  const connectToHost = methods => {
    setStateFn = methods.setState;
    return { promise: Promise.resolve(hostApi) };
  };
  return {
    connectToHost,
    pushSnapshot: snap => setStateFn(snap),
    openSessionCalls,
    revealOutcomeCalls,
  };
}

function baseSnapshot({ balanceHuman, sessions = [] }) {
  return {
    apiVersion: 1,
    integration: { chainId: 31337, slug: 'local', gameAddress: '0xgame', manifest: {} },
    wallet: { address: '0xplayer', smartVaultAddress: '0xplayer', status: 'ready' },
    token: { symbol: 'chUSD', decimals: DECIMALS },
    balances: { smartVaultBalance: humanBalanceToBase(balanceHuman) },
    sessions: { items: sessions },
    ui: { locale: 'en', theme: 'light' },
  };
}

let passed = 0;
function check(label, actual, expected) {
  assert.deepEqual(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  passed++;
  console.log(`OK   ${label}`);
}

async function main() {
  // --- unit conversion round-trips ---
  check('toBaseUnits(10.5, 18)', toBaseUnits(10.5, 18), (10n * UNIT + UNIT / 2n).toString());
  check('toHumanNumber(base(10.5), 18)', toHumanNumber(toBaseUnits(10.5, 18), 18), 10.5);
  check('toBaseUnits(1000000, 18) round-trips', toHumanNumber(toBaseUnits(1_000_000, 18), 18), 1_000_000);

  // --- ready()/balance() read the current on-chain balance ---
  const fakeHost = makeFakeHost();
  const bridge = createExternalBridge(fakeHost.connectToHost);

  const readyPromise = bridge.ready();
  await new Promise(r => setTimeout(r, 20));
  fakeHost.pushSnapshot(baseSnapshot({ balanceHuman: 1_000_000 }));
  const readyResult = await readyPromise;
  check('ready().balance', readyResult.balance, 1_000_000);
  check('ready().currency', readyResult.currency, 'chUSD');

  const balanceResult = await bridge.balance();
  check('balance().balance matches latest snapshot', balanceResult.balance, 1_000_000);

  // --- play() opens a session, waits for settlement, reports amountWon ---
  const playPromise = bridge.play({ betAmount: 10 });
  await new Promise(r => setTimeout(r, 20));
  check('openSession called with correct wager (base units)', fakeHost.openSessionCalls[0].wager, toBaseUnits(10, DECIMALS));
  check('openSession gameData', fakeHost.openSessionCalls[0].gameData, '0x');
  fakeHost.pushSnapshot(
    baseSnapshot({
      balanceHuman: 1_000_000 - 10 + 20,
      sessions: [
        {
          sessionId: '1',
          sessionKey: '31337:1',
          gameAddress: '0xgame',
          phase: 3,
          phaseName: 'SETTLED',
          wager: toBaseUnits(10, DECIMALS),
          payout: toBaseUnits(20, DECIMALS),
          isSettled: true,
          lastEventTimestamp: 0,
          raw: {},
        },
      ],
    }),
  );
  const playResult = await playPromise;
  check('play() resolves amountWon for a win', playResult.amountWon, 20);

  // --- endPlay() calls revealOutcome with the just-settled sessionId ---
  const endPlayResult = await bridge.endPlay();
  check('endPlay() calls revealOutcome with sessionId', fakeHost.revealOutcomeCalls, ['1']);
  check('endPlay() resolves {status:1}', endPlayResult, { status: 1 });

  // --- a losing spin resolves amountWon: 0 ---
  const lossPromise = bridge.play({ betAmount: 50 });
  await new Promise(r => setTimeout(r, 20));
  fakeHost.pushSnapshot(
    baseSnapshot({
      balanceHuman: 1_000_010 - 50,
      sessions: [
        {
          sessionId: '2',
          sessionKey: '31337:2',
          gameAddress: '0xgame',
          phase: 3,
          phaseName: 'SETTLED',
          wager: toBaseUnits(50, DECIMALS),
          payout: '0',
          isSettled: true,
          lastEventTimestamp: 0,
          raw: {},
        },
      ],
    }),
  );
  const lossResult = await lossPromise;
  check('play() resolves amountWon: 0 for a loss', lossResult.amountWon, 0);

  // --- play() only resolves once the session is truly SETTLED, not on an
  //     earlier interim snapshot push (e.g. still WAITING_RANDOMNESS) ---
  const pendingPromise = bridge.play({ betAmount: 1 });
  await new Promise(r => setTimeout(r, 20));
  const pendingSessionKey = '31337:3';
  // First push: still waiting on randomness — must NOT resolve play() yet.
  fakeHost.pushSnapshot(
    baseSnapshot({
      balanceHuman: 1_000_010 - 50 - 1,
      sessions: [
        {
          sessionId: '3',
          sessionKey: pendingSessionKey,
          gameAddress: '0xgame',
          phase: 1,
          phaseName: 'WAITING_RANDOMNESS',
          wager: toBaseUnits(1, DECIMALS),
          payout: '0',
          isSettled: false,
          lastEventTimestamp: 0,
          raw: {},
        },
      ],
    }),
  );
  let pendingSettled = false;
  pendingPromise.then(() => {
    pendingSettled = true;
  });
  await new Promise(r => setTimeout(r, 20));
  check('play() has not resolved while the session is still WAITING_RANDOMNESS', pendingSettled, false);
  // Second push: now truly settled.
  fakeHost.pushSnapshot(
    baseSnapshot({
      balanceHuman: 1_000_010 - 50 - 1 + 130,
      sessions: [
        {
          sessionId: '3',
          sessionKey: pendingSessionKey,
          gameAddress: '0xgame',
          phase: 3,
          phaseName: 'SETTLED',
          wager: toBaseUnits(1, DECIMALS),
          payout: toBaseUnits(130, DECIMALS),
          isSettled: true,
          lastEventTimestamp: 0,
          raw: {},
        },
      ],
    }),
  );
  const pendingResult = await pendingPromise;
  check('play() resolves the payout once truly settled', pendingResult.amountWon, 130);

  // --- debugForceMultiplier bypasses the contract entirely ---
  const debugFakeHost = makeFakeHost();
  const debugBridge = createExternalBridge(debugFakeHost.connectToHost, { debugForceMultiplier: 5 });
  const debugResult = await debugBridge.play({ betAmount: 3 });
  check('debugForceMultiplier resolves amountWon without opening a session', debugResult.amountWon, 15);
  check('debugForceMultiplier never calls openSession', debugFakeHost.openSessionCalls.length, 0);

  console.log(`\nAll ${passed} checks passed.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
