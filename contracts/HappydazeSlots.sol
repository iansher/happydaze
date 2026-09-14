// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ICasinoGameV2, SessionContext, StepResult, SessionPhase} from "./ICasinoGameV2.sol";

/// @title HappydazeSlots
/// @notice On-chain paytable for the "happydaze" slot: a single weighted
///         draw per spin, settled from one VRF value.
///
/// This contract is the sole source of truth for spin outcomes. The actual
/// game (joyplay's "happydaze", loaded unmodified from their own server in
/// `container=external` mode — see the ExternalResultsApiV1 protocol and
/// index.html) only ever receives a single settled `amountWon` figure and
/// constructs its own matching cosmetic reel result internally; nothing
/// here needs to encode reel positions, symbols, or anything else about how
/// a result should look, only how much it should pay.
///
/// An earlier version of this contract additionally modeled a separate
/// bonus-wheel trigger and win-multiplier as a two-step session (a second
/// randomness request for the wheel), on top of this same base paytable.
/// That only made sense when a custom frontend overlay could visually call
/// out "this win came from the bonus wheel" — once the game itself is
/// rendering results (via its own generic seed-replay, indifferent to how
/// the payout was computed), a bonus-triggered win and an ordinary big base
/// win are visually indistinguishable, so the extra step bought nothing but
/// complexity. Removed; a single richer base paytable achieves the same
/// payout distribution and ceiling in one draw.
///
/// `paytable` is the real happydaze payout schedule: 36 base tiers (5-reel
/// wins) plus 12 more (2x-20x) for the 6th-reel wins the game can insert on
/// certain spins, several values repeated (e.g. three different symbols
/// each pay 1x on their own 5-reel tier). Stored in hundredths of the wager
/// (`PAYS_SCALE`) since Solidity has no fractional type and several tiers
/// pay less than a full wager (0.1x, 0.15x, ...). We were only given the
/// payout *values*, not joyplay's real per-symbol reel-strip frequencies,
/// so there's no data to weight tiers by real-world rarity. An earlier
/// design weighted each tier inversely to its payout (rarer = bigger prize,
/// ported from `~/chain/ani-slot-new`'s `SlotGame.sol`) — that breaks down
/// here: the harmonic mean of the base 36 values alone is only ~0.437, so
/// diluting *down* with a no-win bucket can never reach a 96% target
/// (dilution only ever lowers the achievable RTP, never raises it). Instead
/// every listed tier (all 48) is equally likely, diluted by a single no-win
/// bucket sized so the realised RTP equals `targetRTP` exactly — the
/// arithmetic mean of the full schedule (~1.68x) comfortably clears 96%, so
/// this always has a valid solution. Net effect: adding the twelve higher
/// 6th-reel tiers raises that mean enough to pull hit frequency down to a
/// more typical ~42% of spins winning *something*, from ~80% with the base
/// 36 alone — still with no real frequency data to make big wins rarer than
/// small ones within each group, flagged for reconsideration if a more
/// finely-tuned variance shape is wanted later.
///
/// `jackpotPaytable`/`jackpotWeights` add the game's own MINI/MINOR/MAJOR
/// wheel-bonus ladder (100x/250x/1000x, per the in-game bonus wheel — see
/// goofy-puzzling-trinket.md) as genuinely winnable outcomes. The wheel
/// itself is purely cosmetic (the game renders it, or not, based on
/// whatever seed it finds for our declared payout — see the ExternalResults
/// investigation), but without a real chance of an actual 100x/250x/1000x
/// payout the wheel it displays would be un-winnable set dressing, which
/// isn't fair to a player who sees it advertised. Unlike the 48 base tiers,
/// these are deliberately rare (~1-in-11k/114k/1.14M) with a much smaller
/// weighting each, added *additively* on top of the base game's own 96%
/// (same philosophy as the earlier bonus-wheel/multiplier design) — total
/// realised RTP becomes ~97.18% (96% base + ~1.19% jackpot ladder).
contract HappydazeSlots is ICasinoGameV2 {
    error HappydazeSlots__NoPlayerAction();
    error HappydazeSlots__UnexpectedStep(uint32 step);

    uint256 internal constant WAD = 1e18;
    uint256 internal constant SCALE = 1e8; // matches the original 10**8 fixed-point
    uint256 public constant PAYS_SCALE = 100; // paytable values are in hundredths of the wager (e.g. 125 == 1.25x, 10 == 0.1x)

    struct Outcome {
        uint256 weighting;
        uint256 pays; // multiplier applied to the wager, in PAYS_SCALE units (0 = loss)
    }

    // --- paytable state (computed once in the constructor, read-only after) ---
    // The real happydaze payout schedule, descending, in PAYS_SCALE (hundredths)
    // units. First the 12 6th-reel tiers (20x down to 2x), then the 36 base
    // 5-reel tiers (8x down to 0.1x) — see header note.
    uint256[] public paytable;
    Outcome[] public outcomes; // paytable.length winning rows + 1 no-win row + jackpotPaytable.length rows

    uint256 public totalWeighting;
    uint256 public totalOdds;
    uint64 public targetRTP; // 96000000 == 96% (scaled by 1e8) — the base game only; the jackpot ladder below is additive on top

    // MINI, MINOR, MAJOR — see header note. Ascending rarity/payout, so the
    // last entry (MAJOR) is always the single rarest, biggest-paying tier.
    uint256[3] public jackpotPaytable = [10000, 25000, 100000]; // 100x, 250x, 1000x, in PAYS_SCALE units
    uint256[3] public jackpotWeights = [1000000, 100000, 10000]; // ~1-in-11.4k / 114k / 1.14M respectively (relative to totalOdds)

    uint256 public jackpotTotalWeighting;
    uint256 public totalWeightedPaysAll; // sum(weighting_i * pays_i) across every winning outcome, base + jackpot — the numerator for the *true* overall expected payout (base RTP + jackpot's additive EV)

    constructor() {
        paytable = [
            // 6th-reel tiers: 20x, 10x, 5x, 5x, 5x, 4x, 4x, 3x, 3x, 2.5x, 2.5x, 2x
            2000, 1000, 500, 500, 500, 400, 400, 300, 300, 250, 250, 200,
            // base 5-reel tiers: 8x down to 0.1x
            800, 400, 300, 275, 250, 220, 200, 150, 150, 130, 125, 125,
            120, 110, 100, 100, 100, 80, 75, 70, 50, 45, 40, 40, 35,
            30, 30, 30, 25, 25, 25, 20, 20, 15, 15, 10
        ];
        targetRTP = 96000000; // 96%
        _calculateOutcomes();
    }

    /// @dev Every base-paytable tier is given equal weighting (see header
    ///      note for why), then a no-win bucket is appended, sized so the
    ///      realised RTP equals `targetRTP` exactly — this part is
    ///      untouched by the jackpot ladder appended after it, so the base
    ///      game's own 96% is unaffected; the jackpot's own EV is purely
    ///      additive on top (see header note).
    function _calculateOutcomes() private {
        uint256 totalWeightedPays; // sum(weighting_i * pays_i), pays_i in PAYS_SCALE units
        for (uint256 x = 0; x < paytable.length; x++) {
            uint256 weighting = SCALE; // equal odds per tier — see header note
            outcomes.push(Outcome({weighting: weighting, pays: paytable[x]}));
            totalWeighting += weighting;
            totalWeightedPays += weighting * paytable[x];
        }

        uint256 noWinWeighting = (totalWeightedPays * SCALE) / (PAYS_SCALE * targetRTP) - totalWeighting;

        outcomes.push(Outcome({weighting: noWinWeighting, pays: 0}));

        uint256 jackpotWeightedPays;
        for (uint256 x = 0; x < jackpotPaytable.length; x++) {
            outcomes.push(Outcome({weighting: jackpotWeights[x], pays: jackpotPaytable[x]}));
            jackpotTotalWeighting += jackpotWeights[x];
            jackpotWeightedPays += jackpotWeights[x] * jackpotPaytable[x];
        }

        totalOdds = totalWeighting + noWinWeighting + jackpotTotalWeighting;
        totalWeightedPaysAll = totalWeightedPays + jackpotWeightedPays;
    }

    /// @dev Reproducible uniform draw over the cumulative weights from VRF bytes.
    ///      Modulo over `totalOdds` from a uint256 is effectively unbiased
    ///      (domain 2**256 >> totalOdds), so no rejection sampling is needed
    ///      here — unlike a byte->d6 mapping (see RANDOMNESS_DICE.md).
    function _select(bytes32 randomness) internal view returns (uint256 index, uint256 pays) {
        uint256 r = uint256(randomness) % totalOdds;
        uint256 cumulative = 0;
        uint256 x;
        for (x = 0; x < outcomes.length; x++) {
            cumulative += outcomes[x].weighting;
            if (r <= cumulative) break;
        }
        return (x, outcomes[x].pays);
    }

    function _topMultiplier() internal view returns (uint256) {
        return jackpotPaytable[jackpotPaytable.length - 1]; // 100000 (MAJOR, 1000x) is the largest multiplier, in PAYS_SCALE units
    }

    function quoteCaps(
        uint256 wager,
        bytes calldata /* gameData */
    ) external view override returns (uint256 maxEscrowStake, uint256 maxReservedProfit) {
        uint256 maxPayout = (wager * _topMultiplier()) / PAYS_SCALE;
        maxEscrowStake = wager;
        maxReservedProfit = maxPayout > wager ? maxPayout - wager : 0;
    }

    function quoteRiskParams(
        uint256 wager,
        bytes calldata /* gameData */
    )
        external
        view
        override
        returns (
            uint256 maxPayout,
            uint256 probabilityWad,
            uint256 expectedPayout,
            uint256 subJackpotVarianceScaled
        )
    {
        maxPayout = (wager * _topMultiplier()) / PAYS_SCALE;
        // Probability of landing on the single best-paying tier (the last
        // outcome pushed — MAJOR, 1000x), in WAD.
        probabilityWad = (outcomes[outcomes.length - 1].weighting * WAD) / totalOdds;
        // True overall expected payout (base game + the additive jackpot
        // ladder), derived directly from every outcome rather than just
        // `targetRTP` (which only covers the base 96% — see header note).
        expectedPayout = (wager * totalWeightedPaysAll) / (PAYS_SCALE * totalOdds);
        subJackpotVarianceScaled = 0;
    }

    function onSessionStart(
        SessionContext calldata ctx
    ) external view override returns (StepResult memory stepResult) {
        uint256 maxPayout = (ctx.wagerBase * _topMultiplier()) / PAYS_SCALE;

        stepResult.newGameState = ""; // nothing to carry yet — set once the spin resolves
        stepResult.escrowDelta = 0;
        stepResult.reservedProfitDelta = int256(maxPayout > ctx.wagerBase ? maxPayout - ctx.wagerBase : 0);
        stepResult.nextPhase = SessionPhase.WAITING_RANDOMNESS;
        stepResult.requestRandomnessNow = true;
        stepResult.payout = 0;
    }

    function onPlayerAction(
        SessionContext calldata,
        bytes calldata
    ) external pure override returns (StepResult memory) {
        revert HappydazeSlots__NoPlayerAction(); // no mid-round choices — a spin settles in one step
    }

    /// @dev The only randomness callback a session ever gets: resolve the
    ///      tier draw and settle immediately.
    function onRandomness(
        SessionContext calldata ctx,
        bytes32 randomness
    ) external view override returns (StepResult memory stepResult) {
        if (ctx.step != 1) revert HappydazeSlots__UnexpectedStep(ctx.step);

        (uint256 index, uint256 pays) = _select(randomness);
        uint256 payout = (ctx.wagerBase * pays) / PAYS_SCALE;

        stepResult.newGameState = abi.encode(payout, index);
        uint256 neededBeyondEscrow = payout > ctx.wagerBase ? payout - ctx.wagerBase : 0;
        stepResult.escrowDelta = 0;
        stepResult.reservedProfitDelta = int256(neededBeyondEscrow) - int256(ctx.reservedProfit);
        stepResult.nextPhase = SessionPhase.SETTLED;
        stepResult.requestRandomnessNow = false;
        stepResult.payout = payout;
    }

    function quoteForfeitPayout(SessionContext calldata /* ctx */) external pure override returns (uint256) {
        // Nothing accrues before randomness lands and settles the spin in
        // one step, so there's never a partial winnings balance to cash out.
        return 0;
    }

    // ---------------------------------------------------------------------------
    // views
    // ---------------------------------------------------------------------------

    /// @notice Raw base paytable, in PAYS_SCALE (hundredths-of-wager) units —
    ///         e.g. a returned value of 125 means a 1.25x payout. Does not
    ///         include the jackpot ladder — see `getJackpotPaytable`.
    function getPaytable() external view returns (uint256[] memory) {
        return paytable;
    }

    /// @notice The MINI/MINOR/MAJOR jackpot ladder (100x/250x/1000x), in
    ///         PAYS_SCALE units, ascending — see header note.
    function getJackpotPaytable() external view returns (uint256[3] memory) {
        return jackpotPaytable;
    }

    function outcomeCount() external view returns (uint256) {
        return outcomes.length; // paytable.length + 1 (no-win) + jackpotPaytable.length
    }
}
