import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import type { MandateInput, PortfolioState, Proposal } from "../domain/schemas.js";
import { proposalSchema } from "../domain/schemas.js";
import { AppError } from "../errors.js";
import type { BinanceMarketObservation } from "../integrations/binance/market-client.js";

type CandleInterval = "5m" | "15m" | "1h";

const PERIODS_PER_DAY: Record<CandleInterval, number> = { "5m": 288, "15m": 96, "1h": 24 };

export type ScoutCandidateInput = {
  mandate: MandateInput;
  state: PortfolioState;
  asset: string;
  venue: "spot" | "convert";
  market: BinanceMarketObservation;
  closes: string[];
  candleInterval: CandleInterval;
  scoreThreshold: string;
  venueMinNotionalUsd: string;
  now?: Date;
};

export type ScoutScore = {
  score: string;
  threshold: string;
  trendPct: string;
  dailyVolatilityPct: string;
  spreadBps: string;
  candleInterval: CandleInterval;
  candleCount: number;
};

function d(value: string | undefined): Decimal {
  return new Decimal(value ?? "0");
}

function calculateMetrics(closes: string[], interval: CandleInterval, spreadBps: string, friction: Decimal, threshold: string): ScoutScore {
  if (closes.length < 12 || closes.length > 288) {
    throw new AppError(422, "insufficient_market_history", "Scout requires between 12 and 288 candle closes.");
  }
  const prices = closes.map((close) => d(close));
  if (prices.some((price) => !price.isPositive())) {
    throw new AppError(502, "invalid_market_history", "Candle closes must be positive.");
  }
  const returns = prices.slice(1).map((price, index) => price.div(prices[index]!).ln());
  const mean = returns.reduce((sum, value) => sum.plus(value), new Decimal(0)).div(returns.length);
  const variance = returns
    .reduce((sum, value) => sum.plus(value.minus(mean).pow(2)), new Decimal(0))
    .div(Math.max(1, returns.length - 1));
  const dailyVolatilityPct = variance.sqrt().mul(new Decimal(PERIODS_PER_DAY[interval]).sqrt()).mul(100);
  const trendPct = prices.at(-1)!.div(prices[0]!).minus(1).mul(100);

  // This is a transparent screening heuristic, not a return forecast.
  const score = trendPct.minus(d(spreadBps).div(10)).minus(dailyVolatilityPct.div(2)).minus(friction.mul(2));
  return {
    score: score.toDecimalPlaces(8).toFixed(),
    threshold: d(threshold).toFixed(),
    trendPct: trendPct.toDecimalPlaces(8).toFixed(),
    dailyVolatilityPct: dailyVolatilityPct.toDecimalPlaces(8).toFixed(),
    spreadBps: d(spreadBps).toDecimalPlaces(8).toFixed(),
    candleInterval: interval,
    candleCount: closes.length
  };
}

export function createScoutProposal(input: ScoutCandidateInput): Proposal {
  const asset = input.asset.trim().toUpperCase();
  if (!input.mandate.allowedAssets.includes(asset) || asset === input.mandate.baseCurrency) {
    throw new AppError(422, "asset_not_scoutable", "Scout can only assess allowed non-base assets.");
  }
  if (!input.mandate.allowedVenues.includes(input.venue)) {
    throw new AppError(422, "venue_not_allowed", "Scout cannot propose a venue outside the mandate.");
  }
  const expectedSymbol = `${asset}${input.mandate.baseCurrency}`;
  if (input.market.symbol !== expectedSymbol) {
    throw new AppError(422, "market_symbol_mismatch", "The market observation does not match the candidate asset and base currency.");
  }

  const maxOrder = d(input.mandate.maxOrderUsd);
  const capitalHeadroom = Decimal.max(0, d(input.mandate.capitalUsd).minus(d(input.state.totalExposureUsd)));
  const positionCap = d(input.mandate.maxHoldingsUsd[asset]);
  const positionHeadroom = Decimal.max(
    0,
    positionCap.minus(d(input.state.holdingsUsd[asset])).minus(d(input.state.pendingBuyNotionalUsd[asset]))
  );
  const sizeBeforeRisk = Decimal.min(maxOrder, capitalHeadroom, positionHeadroom);
  const capacityRatio = Decimal.min(1, sizeBeforeRisk.div(maxOrder));
  const friction = new Decimal(1).minus(capacityRatio);
  const metrics = calculateMetrics(input.closes, input.candleInterval, input.market.spreadBps, friction, input.scoreThreshold);

  const currentLoss = Decimal.max(0, d(input.state.realizedPnlUsd).plus(d(input.state.unrealizedPnlUsd)).negated());
  const totalRiskBudget = d(input.mandate.capitalUsd).mul(d(input.mandate.maxDrawdownPct)).div(100);
  const remainingRiskBudget = Decimal.max(0, totalRiskBudget.minus(currentLoss));
  const volatilityRiskRate = d(metrics.dailyVolatilityPct).div(100).mul("2.33");
  const spreadRiskRate = d(input.market.spreadBps).div(10_000).mul(2);
  const riskRate = Decimal.max("0.0025", volatilityRiskRate, spreadRiskRate);
  const riskSizedHeadroom = remainingRiskBudget.div(riskRate);
  const notional = Decimal.min(sizeBeforeRisk, riskSizedHeadroom).toDecimalPlaces(2, Decimal.ROUND_FLOOR);
  const clearsScore = d(metrics.score).greaterThanOrEqualTo(d(metrics.threshold));
  const clearsVenueMinimum = notional.greaterThanOrEqualTo(d(input.venueMinNotionalUsd));
  const action = clearsScore && clearsVenueMinimum;
  const createdAt = (input.now ?? new Date()).toISOString();

  return proposalSchema.parse({
    id: randomUUID(),
    sourceRole: "scout",
    type: action ? (d(input.state.holdingsUsd[asset]).greaterThan(0) ? "ADD" : "ENTER") : "HOLD",
    thesis: action
      ? `Screen score ${metrics.score} met threshold ${metrics.threshold}; size is capped by mandate and risk headroom.`
      : `No action. Screen score ${metrics.score} or executable size did not clear the configured threshold and venue minimum.`,
    baseAsset: asset,
    quoteAsset: input.mandate.baseCurrency,
    side: "BUY",
    venue: input.venue,
    notionalUsd: action ? notional.toFixed(2) : "0",
    expectedRiskUsd: action ? notional.mul(riskRate).toDecimalPlaces(8).toFixed() : "0",
    exitPlan: `Exit in one step by selling ${asset} into ${input.mandate.baseCurrency} through ${input.venue}.`,
    scoutEvidence: metrics,
    marketSnapshot: {
      price: input.market.price,
      change24hPct: input.market.change24hPct,
      spreadBps: input.market.spreadBps,
      funding: null,
      observedAt: input.market.observedAt
    },
    createdAt
  });
}
