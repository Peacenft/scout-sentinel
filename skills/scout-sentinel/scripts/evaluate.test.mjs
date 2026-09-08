import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSkillInput } from "./evaluate.mjs";

const now = new Date("2026-09-07T12:00:10.000Z");
const mandate = {
  name: "Preserve sleeve",
  baseCurrency: "USDC",
  capitalUsd: "200",
  goal: "preserve",
  maxDrawdownPct: "8",
  maxOrderUsd: "25",
  maxSlippageBps: "25",
  allowedAssets: ["BTC", "ETH", "USDC"],
  allowedVenues: ["spot", "convert"],
  forbidFutures: true,
  forbidWithdraw: true,
  requireUserConfirm: true,
  maxHoldingsUsd: { BTC: "60", ETH: "80" },
  exitIfLossPct: "8",
  minLiquidity: "can_exit_via_convert_or_spot"
};

const state = {
  asOf: "2026-09-07T12:00:00.000Z",
  totalExposureUsd: "40",
  holdingsUsd: { USDC: "160", BTC: "40", ETH: "0" },
  realizedPnlUsd: "0",
  unrealizedPnlUsd: "0",
  pendingBuyNotionalUsd: {}
};

function proposal(overrides = {}) {
  return {
    id: "018f85a4-54fd-7d68-a8f2-4d90b5812ee8",
    sourceRole: "scout",
    type: "ENTER",
    thesis: "Live screen passed.",
    baseAsset: "BTC",
    quoteAsset: "USDC",
    side: "BUY",
    venue: "spot",
    notionalUsd: "20",
    expectedRiskUsd: "4",
    exitPlan: "Sell BTC into USDC through Spot.",
    marketSnapshot: {
      price: "111000",
      change24hPct: "1.2",
      spreadBps: "0.9",
      funding: null,
      observedAt: "2026-09-07T12:00:00.000Z"
    },
    createdAt: "2026-09-07T12:00:00.000Z",
    ...overrides
  };
}

function input(proposalValue, stateValue = state) {
  return { mandateVersion: 1, stateMaxAgeSeconds: 30, mandate, state: stateValue, proposal: proposalValue };
}

test("approves a policy-compliant proposal for user confirmation", () => {
  assert.equal(evaluateSkillInput(input(proposal()), now).decision, "APPROVED_NEEDS_USER");
});

test("rejects an asset outside the allowlist", () => {
  const verdict = evaluateSkillInput(input(proposal({ baseAsset: "SOL" })), now);
  assert.equal(verdict.decision, "REJECTED");
  assert.ok(verdict.ruleIds.includes("allowed_assets"));
});

test("rejects an oversized order and returns a safe resize", () => {
  const verdict = evaluateSkillInput(input(proposal({ notionalUsd: "40" })), now);
  assert.equal(verdict.decision, "REJECTED");
  assert.equal(verdict.resizedNotionalUsd, "25");
});

test("blocks pending buys that would bypass the position cap", () => {
  const stacked = { ...state, pendingBuyNotionalUsd: { BTC: "20" } };
  const verdict = evaluateSkillInput(input(proposal(), stacked), now);
  assert.equal(verdict.decision, "REJECTED");
  assert.ok(verdict.ruleIds.includes("stacking"));
});

test("returns NO_ACTION for HOLD", () => {
  const verdict = evaluateSkillInput(input(proposal({ type: "HOLD", notionalUsd: "0", expectedRiskUsd: "0" })), now);
  assert.equal(verdict.decision, "NO_ACTION");
});

test("returns NO_ACTION with a stale-state warning for an old HOLD", () => {
  const oldState = { ...state, asOf: "2026-09-07T11:58:00.000Z" };
  const verdict = evaluateSkillInput(input(proposal({ type: "HOLD", notionalUsd: "0", expectedRiskUsd: "0" }), oldState), now);
  assert.equal(verdict.decision, "NO_ACTION");
  assert.deepEqual(verdict.ruleIds, ["stale_state"]);
});

test("rejects non-UUID proposal IDs", () => {
  assert.throws(
    () => evaluateSkillInput(input(proposal({ id: "scout-hold-20260907T142929Z" })), now),
    /proposal.id must be a UUID/
  );
});
