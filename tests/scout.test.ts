import { describe, expect, it } from "vitest";
import { createScoutProposal } from "../src/scout/score.js";
import { mandate, portfolioState } from "./fixtures.js";

const market = {
  symbol: "BTCUSDC",
  price: "79448.13500000",
  change24hPct: "-0.459",
  spreadBps: "0.00125868",
  funding: null,
  observedAt: "2026-09-07T09:50:00.000Z",
  bidPrice: "79448.13",
  askPrice: "79448.14",
  bidQty: "0.67",
  askQty: "0.31"
} as const;

describe("Scout scoring", () => {
  it("emits HOLD when the visible screen score misses the threshold", () => {
    const result = createScoutProposal({
      mandate,
      state: portfolioState,
      asset: "BTC",
      venue: "spot",
      market,
      closes: ["80000", "79950", "79900", "79850", "79800", "79750", "79700", "79650", "79600", "79550", "79500", "79448"],
      candleInterval: "5m",
      scoreThreshold: "1",
      venueMinNotionalUsd: "5",
      now: new Date("2026-09-07T09:50:05.000Z")
    });
    expect(result.type).toBe("HOLD");
    expect(result.notionalUsd).toBe("0");
    expect(Number(result.scoutEvidence?.score)).toBeLessThan(1);
  });

  it("sizes a qualifying proposal within order, position, capital, and risk limits", () => {
    const result = createScoutProposal({
      mandate,
      state: { ...portfolioState, holdingsUsd: { ...portfolioState.holdingsUsd, BTC: "50" } },
      asset: "BTC",
      venue: "convert",
      market: { ...market, change24hPct: "2.4" },
      closes: ["78000", "78100", "78300", "78500", "78700", "78900", "79100", "79300", "79500", "79700", "79900", "80100"],
      candleInterval: "5m",
      scoreThreshold: "0",
      venueMinNotionalUsd: "5",
      now: new Date("2026-09-07T09:50:05.000Z")
    });
    expect(result.type).toBe("ADD");
    expect(Number(result.notionalUsd)).toBeGreaterThanOrEqual(5);
    expect(Number(result.notionalUsd)).toBeLessThanOrEqual(25);
    expect(Number(result.expectedRiskUsd)).toBeLessThanOrEqual(14);
  });
});
