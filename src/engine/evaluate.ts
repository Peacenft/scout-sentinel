import { Decimal } from "decimal.js";
import type { MandateInput, PortfolioState, Proposal, RuleId, Verdict } from "../domain/schemas.js";

type EvaluationOptions = {
  mandateVersion: number;
  now?: Date;
  stateMaxAgeSeconds: number;
};

type Failure = {
  ruleId: RuleId;
  reason: string;
  resizedNotionalUsd?: string;
};

function d(value: string | undefined): Decimal {
  return new Decimal(value ?? "0");
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(8).toFixed();
}

function lossUsd(state: PortfolioState): Decimal {
  return Decimal.max(0, d(state.realizedPnlUsd).plus(d(state.unrealizedPnlUsd)).negated());
}

function isBuyExposure(proposal: Proposal): boolean {
  return proposal.side === "BUY" && proposal.type !== "HOLD";
}

export function evaluateProposal(
  mandate: MandateInput,
  state: PortfolioState,
  proposal: Proposal,
  options: EvaluationOptions
): Verdict {
  const now = options.now ?? new Date();
  const evaluatedAt = now.toISOString();
  const freshnessTimes = [state.asOf, proposal.createdAt, proposal.marketSnapshot.observedAt].map((value) => now.getTime() - new Date(value).getTime());
  const staleState = freshnessTimes.some((ageMs) => ageMs < 0 || ageMs > options.stateMaxAgeSeconds * 1000);

  if (proposal.type === "HOLD") {
    return {
      proposalId: proposal.id,
      decision: "NO_ACTION",
      ruleIds: staleState ? ["stale_state"] : [],
      reason: staleState
        ? "No action will be taken because the portfolio or market observation is stale."
        : "Scout found no action that improves the mandate outcome.",
      resizedNotionalUsd: null,
      evaluatedAt,
      stateAsOf: state.asOf,
      mandateVersion: options.mandateVersion
    };
  }

  const failures: Failure[] = [];
  if (mandate.maxSlippageBps === undefined) {
    failures.push({ ruleId: "slippage_limit", reason: "The active mandate must define a maximum slippage before any trade can be approved." });
  }
  if (staleState) {
    failures.push({ ruleId: "stale_state", reason: `Portfolio and market state must be no older than ${options.stateMaxAgeSeconds} seconds.` });
  }

  const exitingDisallowedAsset = proposal.type === "PROTECT_EXIT" && !mandate.allowedAssets.includes(proposal.baseAsset);
  if ((!mandate.allowedAssets.includes(proposal.baseAsset) && !exitingDisallowedAsset) || !mandate.allowedAssets.includes(proposal.quoteAsset)) {
    failures.push({ ruleId: "allowed_assets", reason: `${proposal.baseAsset}/${proposal.quoteAsset} is outside the asset allowlist.` });
  }

  if (proposal.quoteAsset !== mandate.baseCurrency) {
    failures.push({ ruleId: "base_currency", reason: `Trades must settle in the mandate base currency, ${mandate.baseCurrency}.` });
  }

  if (!mandate.allowedVenues.includes(proposal.venue)) {
    failures.push({ ruleId: "allowed_venues", reason: `${proposal.venue} is outside the venue allowlist.` });
  }

  const currentLoss = lossUsd(state);
  const exitThreshold = d(mandate.capitalUsd).mul(d(mandate.exitIfLossPct)).div(100);
  const drawdownBreached = currentLoss.greaterThanOrEqualTo(exitThreshold);
  if (drawdownBreached && proposal.type !== "PROTECT_EXIT") {
    failures.push({ ruleId: "drawdown_halt", reason: "The sleeve has reached its loss threshold. New exposure is halted." });
  }

  if (d(proposal.notionalUsd).greaterThan(d(mandate.maxOrderUsd))) {
    failures.push({
      ruleId: "max_order_usd",
      reason: `The requested notional exceeds the ${mandate.maxOrderUsd} USD order limit.`,
      resizedNotionalUsd: mandate.maxOrderUsd
    });
  }

  if (proposal.side === "SELL" && d(proposal.notionalUsd).greaterThan(d(state.holdingsUsd[proposal.baseAsset]))) {
    failures.push({ ruleId: "insufficient_position", reason: "The sell notional exceeds the current marked position value." });
  }

  if (isBuyExposure(proposal)) {
    const pendingTotal = Object.values(state.pendingBuyNotionalUsd).reduce((sum, amount) => sum.plus(d(amount)), new Decimal(0));
    const resultingExposure = d(state.totalExposureUsd).plus(pendingTotal).plus(d(proposal.notionalUsd));
    if (resultingExposure.greaterThan(d(mandate.capitalUsd))) {
      failures.push({ ruleId: "capital", reason: "The order plus current and committed exposure exceeds sleeve capital." });
    }

    const holding = d(state.holdingsUsd[proposal.baseAsset]);
    const positionCap = mandate.maxHoldingsUsd[proposal.baseAsset];
    if (positionCap !== undefined && holding.plus(d(proposal.notionalUsd)).greaterThan(d(positionCap))) {
      failures.push({ ruleId: "position_cap", reason: `The order would exceed the ${positionCap} USD ${proposal.baseAsset} position cap.` });
    }

    const pendingForAsset = d(state.pendingBuyNotionalUsd[proposal.baseAsset]);
    if (positionCap !== undefined && pendingForAsset.greaterThan(0) && holding.plus(pendingForAsset).plus(d(proposal.notionalUsd)).greaterThan(d(positionCap))) {
      failures.push({ ruleId: "stacking", reason: "Existing pending buys plus this order would bypass the position cap." });
    }

    const lossBudget = d(mandate.capitalUsd).mul(d(mandate.maxDrawdownPct)).div(100);
    if (currentLoss.plus(d(proposal.expectedRiskUsd)).greaterThan(lossBudget)) {
      failures.push({ ruleId: "risk_per_trade", reason: "Expected risk exceeds the remaining drawdown budget." });
    }
  }

  if (failures.length > 0) {
    return {
      proposalId: proposal.id,
      decision: "REJECTED",
      ruleIds: [...new Set(failures.map((failure) => failure.ruleId))],
      reason: failures.map((failure) => failure.reason).join(" "),
      resizedNotionalUsd: failures.find((failure) => failure.resizedNotionalUsd)?.resizedNotionalUsd ?? null,
      evaluatedAt,
      stateAsOf: state.asOf,
      mandateVersion: options.mandateVersion
    };
  }

  if (proposal.type === "PROTECT_EXIT") {
    return {
      proposalId: proposal.id,
      decision: "PROTECT_EXIT",
      ruleIds: [
        ...(drawdownBreached ? ["drawdown_halt" as const] : []),
        ...(exitingDisallowedAsset ? ["allowed_assets" as const] : [])
      ],
      reason: drawdownBreached
        ? `The sleeve loss is ${money(currentLoss)} USD and has reached the protection threshold.`
        : "Sentinel requested a policy-compliant reduction in exposure.",
      resizedNotionalUsd: null,
      evaluatedAt,
      stateAsOf: state.asOf,
      mandateVersion: options.mandateVersion
    };
  }

  return {
    proposalId: proposal.id,
    decision: "APPROVED_NEEDS_USER",
    ruleIds: [],
    reason: "The proposal is within the active mandate and requires explicit user confirmation.",
    resizedNotionalUsd: null,
    evaluatedAt,
    stateAsOf: state.asOf,
    mandateVersion: options.mandateVersion
  };
}
