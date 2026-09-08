import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors.js";
import { BinanceMarketClient, type McpToolClient } from "../src/integrations/binance/market-client.js";

class RecordedToolClient implements McpToolClient {
  constructor(
    private readonly tools: ReadonlySet<string>,
    private readonly responses: Readonly<Record<string, unknown>>
  ) {}

  async listToolNames(): Promise<ReadonlySet<string>> {
    return this.tools;
  }

  async callTool(name: string): Promise<unknown> {
    const response = this.responses[name];
    if (response === undefined) throw new Error(`Unexpected tool call: ${name}`);
    return response;
  }
}

const toolNames = new Set([
  "get_spot_symbol_price_ticker",
  "get_spot_symbol_order_book_ticker",
  "get_spot_24hr_ticker_price_change_statistics",
  "get_spot_kline_candlestick_data"
]);

describe("Binance market adapter", () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date("2026-09-07T09:58:40.000Z")));
  afterEach(() => vi.useRealTimers());

  it("normalizes the verified live Spot response shape", async () => {
    const client = new BinanceMarketClient(new RecordedToolClient(toolNames, {
      get_spot_symbol_price_ticker: { structuredContent: { result: { symbol: "BTCUSDC", price: "79448.13000000" } } },
      get_spot_symbol_order_book_ticker: {
        structuredContent: {
          result: { symbol: "BTCUSDC", bidPrice: "79448.13000000", bidQty: "0.66790000", askPrice: "79448.14000000", askQty: "0.31566000" }
        }
      },
      get_spot_24hr_ticker_price_change_statistics: {
        structuredContent: { result: { symbol: "BTCUSDC", priceChangePercent: "-0.459", closeTime: 1788775118000 } }
      }
    }));
    await client.verifyCapabilities();
    const market = await client.observe("btcusdc");
    expect(market.symbol).toBe("BTCUSDC");
    expect(market.price).toBe("79448.13500000");
    expect(Number(market.spreadBps)).toBeGreaterThan(0);
    expect(market.funding).toBeNull();
  });

  it("fails closed when a required tool is absent", async () => {
    const client = new BinanceMarketClient(new RecordedToolClient(new Set(), {}));
    await expect(client.verifyCapabilities()).rejects.toMatchObject({ code: "binance_capability_missing", statusCode: 503 } satisfies Partial<AppError>);
  });

  it("rejects unstructured provider responses", async () => {
    const client = new BinanceMarketClient(new RecordedToolClient(toolNames, {
      get_spot_symbol_price_ticker: { content: [{ type: "text", text: "79448" }] },
      get_spot_symbol_order_book_ticker: { structuredContent: { result: {} } },
      get_spot_24hr_ticker_price_change_statistics: { structuredContent: { result: {} } }
    }));
    await expect(client.observe("BTCUSDC")).rejects.toMatchObject({ code: "binance_response_invalid", statusCode: 502 } satisfies Partial<AppError>);
  });
});
