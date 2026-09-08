import { z } from "zod";

export const decimalString = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/, "must be a non-negative decimal string");
export const signedDecimalString = z.string().regex(/^-?(0|[1-9]\d*)(\.\d+)?$/, "must be a decimal string");
export const assetCode = z.string().regex(/^[A-Z0-9]{2,16}$/);

export const mandateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  baseCurrency: assetCode,
  capitalUsd: decimalString,
  goal: z.enum(["preserve"]),
  maxDrawdownPct: decimalString,
  maxOrderUsd: decimalString,
  maxSlippageBps: decimalString.optional(),
  allowedAssets: z.array(assetCode).min(1).max(50),
  allowedVenues: z.array(z.enum(["spot", "convert"])).min(1),
  forbidFutures: z.literal(true),
  forbidWithdraw: z.literal(true),
  requireUserConfirm: z.literal(true),
  maxHoldingsUsd: z.record(assetCode, decimalString),
  exitIfLossPct: decimalString,
  minLiquidity: z.literal("can_exit_via_convert_or_spot")
}).strict().superRefine((value, context) => {
  if (!value.allowedAssets.includes(value.baseCurrency)) {
    context.addIssue({ code: "custom", path: ["allowedAssets"], message: "baseCurrency must be allowed" });
  }
  for (const [path, amount] of [["capitalUsd", value.capitalUsd], ["maxOrderUsd", value.maxOrderUsd]] as const) {
    if (Number(amount) <= 0) {
      context.addIssue({ code: "custom", path: [path], message: "must be greater than zero" });
    }
  }
  for (const [path, percentage] of [["maxDrawdownPct", value.maxDrawdownPct], ["exitIfLossPct", value.exitIfLossPct]] as const) {
    const numeric = Number(percentage);
    if (numeric <= 0 || numeric > 100) {
      context.addIssue({ code: "custom", path: [path], message: "must be greater than zero and at most 100" });
    }
  }
  if (value.maxSlippageBps !== undefined) {
    const numeric = Number(value.maxSlippageBps);
    if (numeric <= 0 || numeric > 100) {
      context.addIssue({ code: "custom", path: ["maxSlippageBps"], message: "must be greater than zero and at most 100 basis points" });
    }
  }
  for (const allowedAsset of value.allowedAssets) {
    if (allowedAsset !== value.baseCurrency && value.maxHoldingsUsd[allowedAsset] === undefined) {
      context.addIssue({ code: "custom", path: ["maxHoldingsUsd", allowedAsset], message: "a position cap is required for every non-base asset" });
    }
  }
});

export const marketSnapshotSchema = z.object({
  price: decimalString,
  change24hPct: signedDecimalString,
  spreadBps: decimalString,
  funding: signedDecimalString.nullable(),
  observedAt: z.iso.datetime()
}).strict();

export const scoutEvidenceSchema = z.object({
  score: signedDecimalString,
  threshold: signedDecimalString,
  trendPct: signedDecimalString,
  dailyVolatilityPct: decimalString,
  spreadBps: decimalString,
  candleInterval: z.enum(["5m", "15m", "1h"]),
  candleCount: z.number().int().min(12).max(288)
}).strict();

export const proposalSchema = z.object({
  id: z.uuid(),
  sourceRole: z.enum(["scout", "sentinel"]),
  type: z.enum(["ENTER", "ADD", "ROTATE", "HOLD", "PROTECT_EXIT"]),
  thesis: z.string().trim().min(1).max(1000),
  baseAsset: assetCode,
  quoteAsset: assetCode,
  side: z.enum(["BUY", "SELL"]),
  venue: z.enum(["spot", "convert"]),
  notionalUsd: decimalString,
  expectedRiskUsd: decimalString,
  exitPlan: z.string().trim().min(1).max(500),
  scoutEvidence: scoutEvidenceSchema.optional(),
  marketSnapshot: marketSnapshotSchema,
  createdAt: z.iso.datetime()
}).strict().superRefine((value, context) => {
  if (value.type === "HOLD" && value.notionalUsd !== "0") {
    context.addIssue({ code: "custom", path: ["notionalUsd"], message: "HOLD must have zero notional" });
  }
  if (value.type !== "HOLD" && Number(value.notionalUsd) <= 0) {
    context.addIssue({ code: "custom", path: ["notionalUsd"], message: "an actionable proposal must have positive notional" });
  }
  if (Number(value.marketSnapshot.price) <= 0) {
    context.addIssue({ code: "custom", path: ["marketSnapshot", "price"], message: "price must be greater than zero" });
  }
  if (value.type === "PROTECT_EXIT" && (value.sourceRole !== "sentinel" || value.side !== "SELL")) {
    context.addIssue({ code: "custom", path: ["type"], message: "PROTECT_EXIT must be a Sentinel SELL" });
  }
  if (value.sourceRole === "scout" && value.scoutEvidence === undefined) {
    context.addIssue({ code: "custom", path: ["scoutEvidence"], message: "Scout proposals require visible scoring evidence" });
  }
});

export const portfolioStateSchema = z.object({
  asOf: z.iso.datetime(),
  totalExposureUsd: decimalString,
  holdingsUsd: z.record(assetCode, decimalString),
  realizedPnlUsd: signedDecimalString,
  unrealizedPnlUsd: signedDecimalString,
  pendingBuyNotionalUsd: z.record(assetCode, decimalString).default({})
}).strict();

export type MandateInput = z.infer<typeof mandateSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type PortfolioState = z.infer<typeof portfolioStateSchema>;

export const ruleIdSchema = z.enum([
  "capital",
  "allowed_assets",
  "allowed_venues",
  "max_order_usd",
  "position_cap",
  "risk_per_trade",
  "drawdown_halt",
  "scout_cannot_trade",
  "no_withdraw",
  "stacking",
  "stale_state",
  "base_currency",
  "insufficient_position",
  "slippage_limit"
]);

export type RuleId = z.infer<typeof ruleIdSchema>;

export const verdictSchema = z.object({
  proposalId: z.uuid(),
  decision: z.enum(["APPROVED_NEEDS_USER", "REJECTED", "NO_ACTION", "PROTECT_EXIT"]),
  ruleIds: z.array(ruleIdSchema),
  reason: z.string().min(1),
  resizedNotionalUsd: decimalString.nullable(),
  evaluatedAt: z.iso.datetime(),
  stateAsOf: z.iso.datetime(),
  mandateVersion: z.number().int().positive()
}).strict();

export type Verdict = z.infer<typeof verdictSchema>;
