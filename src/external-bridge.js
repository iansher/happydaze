// Pure bridge logic between the ExternalResultsApiV1 postMessage protocol
// (see host-entry.js for the browser wiring) and the Chain SDK guest bridge
// — no window/Penpal wiring here, so it's directly unit-testable with a
// fake `connectToHost`.
//
// Unlike the old Stake Engine RGS integration this replaces, the game never
// needs anything from us but a single settled amount: it constructs its own
// matching cosmetic reel result internally (container=external mode). So
// there's no seed, no unit-conversion-to-micro-cents convention, and no
// gameState decoding here — `play()` just reports `settled.payout` in the
// game's own currency units.

export function toBaseUnits(humanAmount, decimals) {
  const [whole, frac = ''] = String(humanAmount).split('.');
  const paddedFrac = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(paddedFrac || '0')).toString();
}

export function toHumanNumber(baseAmount, decimals) {
  const value = BigInt(baseAmount);
  const divisor = 10n ** BigInt(decimals);
  const whole = Number(value / divisor);
  const frac = Number(value % divisor) / Number(divisor);
  return whole + frac;
}

/**
 * @param {(methods: {setState(snapshot): Promise<void>}) => {promise: Promise<HostApiV1>}} connectToHost
 * @param {{debugForceMultiplier?: number|null}} [options]
 *   `debugForceMultiplier`, when set, makes every `play()` resolve
 *   immediately at `betAmount * debugForceMultiplier`, bypassing the real
 *   contract entirely — for exercising the game's own win-rendering
 *   (including its native bonus-wheel visual, which we can't otherwise
 *   request — see goofy-puzzling-trinket.md) without waiting on rare real
 *   triggers or spending real gas/VRF round-trips.
 */
export function createExternalBridge(connectToHost, options = {}) {
  const { debugForceMultiplier = null } = options;
  let hostApi = null;
  let latestSnapshot = null;
  let resolveHostReady;
  const hostApiPromise = new Promise(resolve => {
    resolveHostReady = resolve;
  });
  const settleWatchers = new Map(); // sessionKey -> {resolve}
  let lastSettledSessionId = null;

  const connection = connectToHost({
    async setState(snapshot) {
      latestSnapshot = snapshot;
      if (!snapshot) return;
      for (const item of snapshot.sessions.items) {
        const watcher = settleWatchers.get(item.sessionKey);
        if (watcher && item.isSettled) {
          settleWatchers.delete(item.sessionKey);
          watcher.resolve(item);
        }
      }
    },
  });

  connection.promise.then(
    api => {
      hostApi = api;
      resolveHostReady(api);
    },
    () => {
      // Handshake failed (opened outside the host iframe) — requests below
      // hang on hostApiPromise, which surfaces to the game as a stalled
      // ready()/play() call.
    },
  );

  function waitForSettlement(sessionKey) {
    return new Promise(resolve => {
      settleWatchers.set(sessionKey, { resolve });
    });
  }

  async function waitForReadySnapshot() {
    await hostApiPromise;
    while (!latestSnapshot || latestSnapshot.wallet.status !== 'ready') {
      await new Promise(r => setTimeout(r, 100));
    }
    return latestSnapshot;
  }

  function currentBalanceHuman(snapshot) {
    const decimals = snapshot.token.decimals ?? 18;
    return toHumanNumber(snapshot.balances.smartVaultBalance ?? '0', decimals);
  }

  async function readBalance() {
    const snapshot = await waitForReadySnapshot();
    return { balance: currentBalanceHuman(snapshot), currency: snapshot.token.symbol ?? 'CHAIN' };
  }

  // `ready` and `balance` are identical reads — ExternalResultsApiV1 just
  // calls them at different points (once at boot, then on demand).
  async function ready() {
    return readBalance();
  }

  async function balance() {
    return readBalance();
  }

  async function play({ betAmount }) {
    if (debugForceMultiplier != null) {
      return { amountWon: betAmount * debugForceMultiplier };
    }

    const api = await hostApiPromise;
    const snapshot = await waitForReadySnapshot();
    const decimals = snapshot.token.decimals ?? 18;
    const wager = toBaseUnits(betAmount, decimals);

    const opened = await api.openSession({ wager, gameData: '0x', randomnessRequestData: '0x' });
    const settled = await waitForSettlement(opened.sessionKey);
    lastSettledSessionId = settled.sessionId;

    const amountWon = toHumanNumber(settled.payout ?? '0', decimals);
    return { amountWon };
  }

  async function endPlay() {
    const api = await hostApiPromise;
    if (lastSettledSessionId != null) {
      await api.revealOutcome({ sessionId: lastSettledSessionId });
      lastSettledSessionId = null;
    }
    return { status: 1 };
  }

  return { ready, balance, play, endPlay };
}
