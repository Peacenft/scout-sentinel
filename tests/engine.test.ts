import { describe, expect, it } from "vitest";
import { checkExecutionGate } from "../src/engine/execution-gate.js";
import { evaluateProposal } from "../src/engine/evaluate.js";
import { fixedNow, mandate, portfolioState, proposal } from "./fixtures.js";

const options = { mandateVersion: 1, now: fixedNow, stateMaxAgeSeconds: 30 };

describe("Sentinel policy engine", () => {
  it("rejects an asset outside the allowlist", () => {
    const verdict = evaluateProposal(mandate, portfolioState, proposal({ baseAsset: "SOL" }), options);
    expect(verdict.decision).toBe("REJECTED");
    expect(verdict.ruleIds).toContain("allowed_assets");
  });

  it("rejects and reports a safe resize for an oversized order", () => {
    const verdict = evaluateProposal(mandate, portfolioState, proposal({ notionalUsd: "40" }), options);
    expect(verdict.decision).toBe("REJECTED");
    expect(verdict.ruleIds).toContain("max_order_usd");
    expect(verdict.resizedNotionalUsd).toBe("25");
  });

  it("returns NO_ACTION for HOLD", () => {
    const verdict = evaluateProposal(mandate, portfolioState, proposal({ type: "HOLD", notionalUsd: "0", expectedRiskUsd: "0" }), options);
    expect(verdict.decision).toBe("NO_ACTION");
    expect(verdict.ruleIds).toEqual([]);
  });

  it("returns NO_ACTION with a stale-state warning for an old HOLD observation", () => {
    const staleState = { ...portfolioState, asOf: "2026-09-07T11:58:00.000Z" };
    const verdict = evaluateProposal(
      mandate,
      staleState,
      proposal({ type: "HOLD", notionalUsd: "0", expectedRiskUsd: "0" }),
      options
    );
    expect(verdict.decision).toBe("NO_ACTION");
    expect(verdict.ruleIds).toEqual(["stale_state"]);
  });

  it("rejects state that is too old for a consequential decision", () => {
    const staleState = { ...portfolioState, asOf: "2026-09-07T11:58:00.000Z" };
    const verdict = evaluateProposal(mandate, staleState, proposal(), options);
    expect(verdict.ruleIds).toContain("stale_state");
  });

  it("blocks execution when the caller claims the Scout role", () => {
    const candidate = proposal();
    const verdict = evaluateProposal(mandate, portfolioState, candidate, options);
    const gate = checkExecutionGate(candidate, verdict, { actionKind: "trade", sourceRole: "scout" });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.ruleIds).toContain("scout_cannot_trade");
  });

  it("allows Sentinel to execute a Scout proposal after approval", () => {
    const candidate = proposal();
    const verdict = evaluateProposal(mandate, portfolioState, candidate, options);
    expect(checkExecutionGate(candidate, verdict, { actionKind: "trade", sourceRole: "sentinel" })).toEqual({ allowed: true });
  });

  it("always blocks withdrawal intents", () => {
    const candidate = proposal({ sourceRole: "sentinel" });
    const verdict = evaluateProposal(mandate, portfolioState, candidate, options);
    const gate = checkExecutionGate(candidate, verdict, { actionKind: "withdraw", sourceRole: "sentinel" });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.ruleIds).toContain("no_withdraw");
  });
});
