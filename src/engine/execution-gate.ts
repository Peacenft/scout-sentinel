import type { Proposal, RuleId, Verdict } from "../domain/schemas.js";

export type ExecutionIntent = {
  actionKind: "trade" | "transfer" | "withdraw";
  sourceRole: "scout" | "sentinel";
};

export type ExecutionGateResult =
  | { allowed: true }
  | { allowed: false; ruleIds: RuleId[]; reason: string };

export function checkExecutionGate(
  proposal: Proposal,
  verdict: Verdict,
  intent: ExecutionIntent
): ExecutionGateResult {
  const ruleIds: RuleId[] = [];
  const reasons: string[] = [];

  if (intent.sourceRole !== "sentinel") {
    ruleIds.push("scout_cannot_trade");
    reasons.push("Only Sentinel can submit an execution request.");
  }

  if (intent.actionKind === "withdraw") {
    ruleIds.push("no_withdraw");
    reasons.push("Withdrawals are prohibited by the mandate and integration boundary.");
  }

  if (intent.actionKind !== "trade") {
    reasons.push("This release authorizes trade actions only.");
  }

  if (!["APPROVED_NEEDS_USER", "PROTECT_EXIT"].includes(verdict.decision)) {
    reasons.push("The policy verdict does not authorize execution.");
  }

  if (verdict.proposalId !== proposal.id) {
    reasons.push("The verdict is bound to a different proposal.");
  }

  return reasons.length === 0
    ? { allowed: true }
    : { allowed: false, ruleIds: [...new Set(ruleIds)], reason: reasons.join(" ") };
}
