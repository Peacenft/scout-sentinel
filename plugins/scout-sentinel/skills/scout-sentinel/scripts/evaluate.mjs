import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const ASSET = /^[A-Z0-9]{2,16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message) {
  throw new Error(message);
}

function object(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
}

function string(value, name) {
  if (typeof value !== "string" || value.length === 0) fail(`${name} must be a non-empty string`);
  return value;
}

function decimal(value, name, signed = false) {
  const text = string(value, name);
  if (!DECIMAL.test(text) || (!signed && text.startsWith("-"))) fail(`${name} must be a decimal string`);
  const unsigned = text.startsWith("-") ? text.slice(1) : text;
  const [whole, fraction = ""] = unsigned.split(".");
  if (whole.length > 30 || fraction.length > 18) fail(`${name} is outside supported precision`);
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${whole}${fraction}` || "0") * (text.startsWith("-") ? -1n : 1n);
  return { n: numerator, d: denominator };
}

function add(a, b) {
  return { n: a.n * b.d + b.n * a.d, d: a.d * b.d };
}

function negate(value) {
  return { n: -value.n, d: value.d };
}

function multiply(a, b) {
  return { n: a.n * b.n, d: a.d * b.d };
}

function divideInteger(value, divisor) {
  return { n: value.n, d: value.d * BigInt(divisor) };
}

function compare(a, b) {
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left < right ? -1 : left > right ? 1 : 0;
}

function greater(a, b) {
  return compare(a, b) > 0;
}

function greaterOrEqual(a, b) {
  return compare(a, b) >= 0;
}

function maxZero(value) {
  return value.n < 0n ? { n: 0n, d: 1n } : value;
}

function sum(values) {
  return values.reduce(add, { n: 0n, d: 1n });
}

function iso(value, name) {
  const text = string(value, name);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) fail(`${name} must be an ISO-8601 UTC timestamp`);
  return text;
}

function asset(value, name) {
  const text = string(value, name);
  if (!ASSET.test(text)) fail(`${name} must be an uppercase asset code`);
  return text;
}

function recordDecimals(value, name, signed = false) {
  const record = object(value, name);
  for (const [key, amount] of Object.entries(record)) {
    asset(key, `${name} key`);
    decimal(amount, `${name}.${key}`, signed);
  }
  return record;
}

function requireBoolean(value, expected, name) {
  if (value !== expected) fail(`${name} must be ${expected}`);
}

function validate(input) {
  const root = object(input, "input");
  const mandate = object(root.mandate, "mandate");
  const state = object(root.state, "state");
  const proposal = object(root.proposal, "proposal");
  const market = object(proposal.marketSnapshot, "proposal.marketSnapshot");

  if (!Number.isInteger(root.mandateVersion) || root.mandateVersion < 1) fail("mandateVersion must be a positive integer");
  if (!Number.isInteger(root.stateMaxAgeSeconds) || root.stateMaxAgeSeconds < 1 || root.stateMaxAgeSeconds > 300) fail("stateMaxAgeSeconds must be between 1 and 300");
  string(mandate.name, "mandate.name");
  asset(mandate.baseCurrency, "mandate.baseCurrency");
  decimal(mandate.capitalUsd, "mandate.capitalUsd");
  decimal(mandate.maxDrawdownPct, "mandate.maxDrawdownPct");
  decimal(mandate.maxOrderUsd, "mandate.maxOrderUsd");
  const maxSlippage = decimal(mandate.maxSlippageBps, "mandate.maxSlippageBps");
  if (!greater(maxSlippage, decimal("0", "zero")) || greater(maxSlippage, decimal("100", "one hundred"))) fail("mandate.maxSlippageBps must be greater than zero and at most 100");
  decimal(mandate.exitIfLossPct, "mandate.exitIfLossPct");
  if (mandate.goal !== "preserve") fail("mandate.goal must be preserve");
  if (!Array.isArray(mandate.allowedAssets) || mandate.allowedAssets.length === 0) fail("mandate.allowedAssets must be a non-empty array");
  mandate.allowedAssets.forEach((value, index) => asset(value, `mandate.allowedAssets[${index}]`));
  if (!mandate.allowedAssets.includes(mandate.baseCurrency)) fail("mandate.allowedAssets must include baseCurrency");
  if (!Array.isArray(mandate.allowedVenues) || mandate.allowedVenues.length === 0 || mandate.allowedVenues.some((value) => !["spot", "convert"].includes(value))) fail("mandate.allowedVenues must contain spot or convert");
  requireBoolean(mandate.forbidFutures, true, "mandate.forbidFutures");
  requireBoolean(mandate.forbidWithdraw, true, "mandate.forbidWithdraw");
  requireBoolean(mandate.requireUserConfirm, true, "mandate.requireUserConfirm");
  recordDecimals(mandate.maxHoldingsUsd, "mandate.maxHoldingsUsd");
  if (mandate.minLiquidity !== "can_exit_via_convert_or_spot") fail("mandate.minLiquidity is invalid");

  iso(state.asOf, "state.asOf");
  decimal(state.totalExposureUsd, "state.totalExposureUsd");
  recordDecimals(state.holdingsUsd, "state.holdingsUsd");
  decimal(state.realizedPnlUsd, "state.realizedPnlUsd", true);
  decimal(state.unrealizedPnlUsd, "state.unrealizedPnlUsd", true);
  recordDecimals(state.pendingBuyNotionalUsd, "state.pendingBuyNotionalUsd");

  string(proposal.id, "proposal.id");
  if (!UUID.test(proposal.id)) fail("proposal.id must be a UUID");
  if (!["scout", "sentinel"].includes(proposal.sourceRole)) fail("proposal.sourceRole is invalid");
  if (!["ENTER", "ADD", "ROTATE", "HOLD", "PROTECT_EXIT"].includes(proposal.type)) fail("proposal.type is invalid");
  string(proposal.thesis, "proposal.thesis");
  asset(proposal.baseAsset, "proposal.baseAsset");
  asset(proposal.quoteAsset, "proposal.quoteAsset");
  if (!["BUY", "SELL"].includes(proposal.side)) fail("proposal.side is invalid");
  if (!["spot", "convert"].includes(proposal.venue)) fail("proposal.venue is invalid");
  decimal(proposal.notionalUsd, "proposal.notionalUsd");
  decimal(proposal.expectedRiskUsd, "proposal.expectedRiskUsd");
  string(proposal.exitPlan, "proposal.exitPlan");
  decimal(market.price, "proposal.marketSnapshot.price");
  decimal(market.change24hPct, "proposal.marketSnapshot.change24hPct", true);
  decimal(market.spreadBps, "proposal.marketSnapshot.spreadBps");
  if (market.funding !== null) decimal(market.funding, "proposal.marketSnapshot.funding", true);
  iso(market.observedAt, "proposal.marketSnapshot.observedAt");
  iso(proposal.createdAt, "proposal.createdAt");

  if (proposal.type === "HOLD" && compare(decimal(proposal.notionalUsd, "proposal.notionalUsd"), decimal("0", "zero")) !== 0) fail("HOLD must have zero notionalUsd");
  if (proposal.type !== "HOLD" && !greater(decimal(proposal.notionalUsd, "proposal.notionalUsd"), decimal("0", "zero"))) fail("actionable proposals require positive notionalUsd");
  if (proposal.type === "PROTECT_EXIT" && (proposal.sourceRole !== "sentinel" || proposal.side !== "SELL")) fail("PROTECT_EXIT must be a Sentinel SELL");
  return { root, mandate, state, proposal, market };
}

export function evaluateSkillInput(input, now = new Date()) {
  const { root, mandate, state, proposal, market } = validate(input);
  const evaluatedAt = now.toISOString();
  const freshness = [state.asOf, proposal.createdAt, market.observedAt].map((value) => now.getTime() - Date.parse(value));
  const staleState = freshness.some((age) => age < 0 || age > root.stateMaxAgeSeconds * 1000);

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
      mandateVersion: root.mandateVersion
    };
  }

  const failures = [];
  if (staleState) failures.push(["stale_state", `Portfolio and market state must be no older than ${root.stateMaxAgeSeconds} seconds.`]);

  const exitingDisallowedAsset = proposal.type === "PROTECT_EXIT" && !mandate.allowedAssets.includes(proposal.baseAsset);
  if ((!mandate.allowedAssets.includes(proposal.baseAsset) && !exitingDisallowedAsset) || !mandate.allowedAssets.includes(proposal.quoteAsset)) failures.push(["allowed_assets", `${proposal.baseAsset}/${proposal.quoteAsset} is outside the asset allowlist.`]);
  if (proposal.quoteAsset !== mandate.baseCurrency) failures.push(["base_currency", `Trades must settle in ${mandate.baseCurrency}.`]);
  if (!mandate.allowedVenues.includes(proposal.venue)) failures.push(["allowed_venues", `${proposal.venue} is outside the venue allowlist.`]);

  const currentLoss = maxZero(negate(add(decimal(state.realizedPnlUsd, "state.realizedPnlUsd", true), decimal(state.unrealizedPnlUsd, "state.unrealizedPnlUsd", true))));
  const exitThreshold = divideInteger(multiply(decimal(mandate.capitalUsd, "mandate.capitalUsd"), decimal(mandate.exitIfLossPct, "mandate.exitIfLossPct")), 100);
  const drawdownBreached = greaterOrEqual(currentLoss, exitThreshold);
  if (drawdownBreached && proposal.type !== "PROTECT_EXIT") failures.push(["drawdown_halt", "The sleeve has reached its loss threshold. New exposure is halted."]);

  const notional = decimal(proposal.notionalUsd, "proposal.notionalUsd");
  if (greater(notional, decimal(mandate.maxOrderUsd, "mandate.maxOrderUsd"))) failures.push(["max_order_usd", `The requested notional exceeds the ${mandate.maxOrderUsd} USD order limit.`, mandate.maxOrderUsd]);
  if (proposal.side === "SELL" && greater(notional, decimal(state.holdingsUsd[proposal.baseAsset] ?? "0", `state.holdingsUsd.${proposal.baseAsset}`))) failures.push(["insufficient_position", "The sell notional exceeds the current marked position value."]);

  if (proposal.side === "BUY") {
    const pendingTotal = sum(Object.values(state.pendingBuyNotionalUsd).map((value) => decimal(value, "pending buy")));
    const exposure = sum([decimal(state.totalExposureUsd, "state.totalExposureUsd"), pendingTotal, notional]);
    if (greater(exposure, decimal(mandate.capitalUsd, "mandate.capitalUsd"))) failures.push(["capital", "The order plus current and committed exposure exceeds sleeve capital."]);

    const holding = decimal(state.holdingsUsd[proposal.baseAsset] ?? "0", `state.holdingsUsd.${proposal.baseAsset}`);
    const pendingAsset = decimal(state.pendingBuyNotionalUsd[proposal.baseAsset] ?? "0", `state.pendingBuyNotionalUsd.${proposal.baseAsset}`);
    const capText = mandate.maxHoldingsUsd[proposal.baseAsset];
    if (capText !== undefined) {
      const cap = decimal(capText, `mandate.maxHoldingsUsd.${proposal.baseAsset}`);
      if (greater(add(holding, notional), cap)) failures.push(["position_cap", `The order would exceed the ${capText} USD ${proposal.baseAsset} position cap.`]);
      if (greater(pendingAsset, decimal("0", "zero")) && greater(sum([holding, pendingAsset, notional]), cap)) failures.push(["stacking", "Existing pending buys plus this order would bypass the position cap."]);
    }

    const riskBudget = divideInteger(multiply(decimal(mandate.capitalUsd, "mandate.capitalUsd"), decimal(mandate.maxDrawdownPct, "mandate.maxDrawdownPct")), 100);
    if (greater(add(currentLoss, decimal(proposal.expectedRiskUsd, "proposal.expectedRiskUsd")), riskBudget)) failures.push(["risk_per_trade", "Expected risk exceeds the remaining drawdown budget."]);
  }

  if (failures.length > 0) {
    return {
      proposalId: proposal.id,
      decision: "REJECTED",
      ruleIds: [...new Set(failures.map(([ruleId]) => ruleId))],
      reason: failures.map(([, reason]) => reason).join(" "),
      resizedNotionalUsd: failures.find((failure) => failure[2])?.[2] ?? null,
      evaluatedAt,
      stateAsOf: state.asOf,
      mandateVersion: root.mandateVersion
    };
  }

  return {
    proposalId: proposal.id,
    decision: proposal.type === "PROTECT_EXIT" ? "PROTECT_EXIT" : "APPROVED_NEEDS_USER",
    ruleIds: proposal.type === "PROTECT_EXIT" ? [...(drawdownBreached ? ["drawdown_halt"] : []), ...(exitingDisallowedAsset ? ["allowed_assets"] : [])] : [],
    reason: proposal.type === "PROTECT_EXIT" ? "Sentinel requested a policy-compliant reduction in exposure." : "The proposal is within the active mandate and requires explicit user confirmation.",
    resizedNotionalUsd: null,
    evaluatedAt,
    stateAsOf: state.asOf,
    mandateVersion: root.mandateVersion
  };
}

async function main() {
  const inputIndex = process.argv.indexOf("--input");
  if (inputIndex === -1 || !process.argv[inputIndex + 1]) fail("Usage: node scripts/evaluate.mjs --input <absolute-json-path>");
  const input = JSON.parse(await readFile(process.argv[inputIndex + 1], "utf8"));
  process.stdout.write(`${JSON.stringify(evaluateSkillInput(input))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: { code: "validation_failed", message: error instanceof Error ? error.message : "Evaluation failed" } })}\n`);
    process.exitCode = 2;
  });
}
