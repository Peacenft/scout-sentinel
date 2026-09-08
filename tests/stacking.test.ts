import { expect, it } from "vitest";
import { evaluateProposal } from "../src/engine/evaluate.js";
import { fixedNow, mandate, portfolioState, proposal } from "./fixtures.js";

it("rejects a new buy when pending buys would bypass the position cap", () => {
  const cappedMandate = { ...mandate, maxHoldingsUsd: { ...mandate.maxHoldingsUsd, BTC: "60" } };
  const state = {
    ...portfolioState,
    totalExposureUsd: "40",
    holdingsUsd: { ...portfolioState.holdingsUsd, BTC: "40" },
    pendingBuyNotionalUsd: { BTC: "20" }
  };
  const verdict = evaluateProposal(cappedMandate, state, proposal({ notionalUsd: "20" }), {
    mandateVersion: 1,
    now: fixedNow,
    stateMaxAgeSeconds: 30
  });
  expect(verdict.decision).toBe("REJECTED");
  expect(verdict.ruleIds).toContain("stacking");
});
