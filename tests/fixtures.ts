import type { MandateInput, PortfolioState, Proposal } from "../src/domain/schemas.js";

export const fixedNow = new Date("2026-09-07T12:00:00.000Z");

export const mandate: MandateInput = {
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
  maxHoldingsUsd: { BTC: "120", ETH: "80" },
  exitIfLossPct: "8",
  minLiquidity: "can_exit_via_convert_or_spot"
};

export const portfolioState: PortfolioState = {
  asOf: "2026-09-07T11:59:50.000Z",
  totalExposureUsd: "50",
  holdingsUsd: { BTC: "50", ETH: "0", USDC: "150" },
  realizedPnlUsd: "0",
  unrealizedPnlUsd: "-2",
  pendingBuyNotionalUsd: {}
};

export function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "4f2b6b7f-8c49-4e65-9f73-2641e2a2b4d0",
    sourceRole: "scout",
    type: "ENTER",
    thesis: "Momentum is positive while spread remains within the mandate.",
    baseAsset: "BTC",
    quoteAsset: "USDC",
    side: "BUY",
    venue: "convert",
    notionalUsd: "20",
    expectedRiskUsd: "3",
    exitPlan: "Convert BTC back to USDC.",
    scoutEvidence: {
      score: "1.2",
      threshold: "1",
      trendPct: "2.1",
      dailyVolatilityPct: "1.4",
      spreadBps: "3.5",
      candleInterval: "5m",
      candleCount: 24
    },
    marketSnapshot: {
      price: "80000",
      change24hPct: "2.1",
      spreadBps: "3.5",
      funding: null,
      observedAt: "2026-09-07T11:59:50.000Z"
    },
    createdAt: "2026-09-07T11:59:55.000Z",
    ...overrides
  };
}
