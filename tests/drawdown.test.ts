import { expect, it } from "vitest";
import { evaluateProposal } from "../src/engine/evaluate.js";
import { fixedNow, mandate, portfolioState, proposal } from "./fixtures.js";

it("halts new exposure once the drawdown threshold is reached", () => {
  const state = { ...portfolioState, realizedPnlUsd: "-5", unrealizedPnlUsd: "-11" };
  const verdict = evaluateProposal(mandate, state, proposal(), {
    mandateVersion: 1,
    now: fixedNow,
    stateMaxAgeSeconds: 30
  });
  expect(verdict.decision).toBe("REJECTED");
  expect(verdict.ruleIds).toContain("drawdown_halt");
});

it("allows a Sentinel protection exit after the drawdown threshold is reached", () => {
  const state = { ...portfolioState, realizedPnlUsd: "-5", unrealizedPnlUsd: "-11" };
  const verdict = evaluateProposal(
    mandate,
    state,
    proposal({ sourceRole: "sentinel", type: "PROTECT_EXIT", side: "SELL", notionalUsd: "10", expectedRiskUsd: "0" }),
    { mandateVersion: 1, now: fixedNow, stateMaxAgeSeconds: 30 }
  );
  expect(verdict.decision).toBe("PROTECT_EXIT");
  expect(verdict.ruleIds).toContain("drawdown_halt");
});

it("allows Sentinel to unwind an asset that has left the allowlist", () => {
  const state = {
    ...portfolioState,
    totalExposureUsd: "10",
    holdingsUsd: { ...portfolioState.holdingsUsd, SOL: "10" }
  };
  const verdict = evaluateProposal(
    mandate,
    state,
    proposal({ sourceRole: "sentinel", type: "PROTECT_EXIT", side: "SELL", baseAsset: "SOL", notionalUsd: "10", expectedRiskUsd: "0" }),
    { mandateVersion: 1, now: fixedNow, stateMaxAgeSeconds: 30 }
  );
  expect(verdict.decision).toBe("PROTECT_EXIT");
  expect(verdict.ruleIds).toContain("allowed_assets");
});

it("rejects a protection exit larger than the marked position", () => {
  const verdict = evaluateProposal(
    mandate,
    portfolioState,
    proposal({ sourceRole: "sentinel", type: "PROTECT_EXIT", side: "SELL", notionalUsd: "60", expectedRiskUsd: "0" }),
    { mandateVersion: 1, now: fixedNow, stateMaxAgeSeconds: 30 }
  );
  expect(verdict.decision).toBe("REJECTED");
  expect(verdict.ruleIds).toContain("insufficient_position");
});
