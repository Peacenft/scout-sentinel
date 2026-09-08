import { Decimal } from "decimal.js";
import { z } from "zod";
import type { Proposal } from "../../domain/schemas.js";
import { AppError } from "../../errors.js";

const PRICE_TOOL = "get_spot_symbol_price_ticker";
const BOOK_TOOL = "get_spot_symbol_order_book_ticker";
const DAY_TOOL = "get_spot_24hr_ticker_price_change_statistics";
const KLINE_TOOL = "get_spot_kline_candlestick_data";

const priceResultSchema = z.object({
  result: z.object({ symbol: z.string(), price: z.string() })
});

const bookResultSchema = z.object({
  result: z.object({
    symbol: z.string(),
    bidPrice: z.string(),
    bidQty: z.string(),
    askPrice: z.string(),
    askQty: z.string()
  })
});

const dayResultSchema = z.object({
  result: z.object({
    symbol: z.string(),
    priceChangePercent: z.string(),
    closeTime: z.number().int()
  })
});

const klineResultSchema = z.object({
  result: z.array(z.array(z.union([z.number(), z.string()])).min(7)).min(2)
});

export interface McpToolClient {
  listToolNames(signal?: AbortSignal): Promise<ReadonlySet<string>>;
  callTool(name: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export type BinanceMarketObservation = Proposal["marketSnapshot"] & {
  symbol: string;
  bidPrice: string;
  askPrice: string;
  bidQty: string;
  askQty: string;
};

function structuredContent(value: unknown): unknown {
  if (value && typeof value === "object" && "structuredContent" in value) {
    return (value as { structuredContent?: unknown }).structuredContent;
  }
  return value;
}

function parseProviderResult<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(structuredContent(value));
  if (!parsed.success) {
    throw new AppError(502, "binance_response_invalid", "Binance returned a response that does not match the verified market schema.", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code }))
    });
  }
  return parsed.data;
}

function retryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const status = "status" in error ? Number((error as { status?: unknown }).status) : undefined;
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  return status === undefined || status === 408 || status === 429 || status >= 500 || ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code);
}

async function readWithRetry<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const timeout = AbortSignal.timeout(5_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await operation(combined);
    } catch (error) {
      lastError = error;
      if (attempt === 1 || !retryable(error) || signal?.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, 150 + Math.floor(Math.random() * 150)));
    }
  }
  throw new AppError(502, "binance_market_read_failed", "Binance market data could not be read after a bounded retry.", {
    cause: lastError instanceof Error ? lastError.name : "unknown"
  });
}

function assertSymbol(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new AppError(502, "binance_symbol_mismatch", "Binance returned data for an unexpected symbol.", { expected, actual });
  }
}

export class BinanceMarketClient {
  constructor(private readonly client: McpToolClient) {}

  async verifyCapabilities(signal?: AbortSignal): Promise<void> {
    const available = await this.client.listToolNames(signal);
    const missing = [PRICE_TOOL, BOOK_TOOL, DAY_TOOL, KLINE_TOOL].filter((name) => !available.has(name));
    if (missing.length > 0) {
      throw new AppError(503, "binance_capability_missing", "Required Binance market tools are unavailable.", { missing });
    }
  }

  async observe(symbol: string, signal?: AbortSignal): Promise<BinanceMarketObservation> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const [priceRaw, bookRaw, dayRaw] = await Promise.all([
      readWithRetry((callSignal) => this.client.callTool(PRICE_TOOL, { symbol: normalizedSymbol, symbolStatus: "TRADING" }, callSignal), signal),
      readWithRetry((callSignal) => this.client.callTool(BOOK_TOOL, { symbol: normalizedSymbol, symbolStatus: "TRADING" }, callSignal), signal),
      readWithRetry(
        (callSignal) => this.client.callTool(DAY_TOOL, { symbol: normalizedSymbol, symbolStatus: "TRADING", type: "FULL" }, callSignal),
        signal
      )
    ]);
    const price = parseProviderResult(priceResultSchema, priceRaw).result;
    const book = parseProviderResult(bookResultSchema, bookRaw).result;
    const day = parseProviderResult(dayResultSchema, dayRaw).result;
    assertSymbol(normalizedSymbol, price.symbol);
    assertSymbol(normalizedSymbol, book.symbol);
    assertSymbol(normalizedSymbol, day.symbol);

    const last = new Decimal(price.price);
    const bid = new Decimal(book.bidPrice);
    const ask = new Decimal(book.askPrice);
    if (!last.isPositive() || !bid.isPositive() || !ask.isPositive() || ask.lessThan(bid)) {
      throw new AppError(502, "binance_invalid_market", "Binance returned an invalid Spot price or book.");
    }
    const mid = bid.plus(ask).div(2);
    const deviationBps = last.minus(mid).abs().div(mid).mul(10_000);
    if (deviationBps.greaterThan(100)) {
      throw new AppError(502, "binance_market_inconsistent", "Ticker and order book prices differ by more than 100 bps.");
    }
    const closeTime = new Date(day.closeTime);
    if (!Number.isFinite(closeTime.getTime()) || Math.abs(Date.now() - closeTime.getTime()) > 60_000) {
      throw new AppError(502, "binance_market_stale", "Binance returned a stale 24-hour ticker.");
    }

    return {
      symbol: normalizedSymbol,
      price: mid.toFixed(8),
      change24hPct: new Decimal(day.priceChangePercent).toFixed(),
      spreadBps: ask.minus(bid).div(mid).mul(10_000).toDecimalPlaces(8).toFixed(),
      funding: null,
      observedAt: closeTime.toISOString(),
      bidPrice: bid.toFixed(),
      askPrice: ask.toFixed(),
      bidQty: new Decimal(book.bidQty).toFixed(),
      askQty: new Decimal(book.askQty).toFixed()
    };
  }

  async recentCloses(symbol: string, interval: "5m" | "15m" | "1h", limit: number, signal?: AbortSignal): Promise<string[]> {
    if (limit < 12 || limit > 288) throw new AppError(400, "invalid_kline_limit", "Kline limit must be between 12 and 288.");
    const normalizedSymbol = symbol.trim().toUpperCase();
    const raw = await readWithRetry(
      (callSignal) => this.client.callTool(KLINE_TOOL, { symbol: normalizedSymbol, interval, limit, timeZone: "0" }, callSignal),
      signal
    );
    const parsed = parseProviderResult(klineResultSchema, raw);
    return parsed.result.map((row) => {
      const close = row[4];
      if (typeof close !== "string" || !new Decimal(close).isPositive()) {
        throw new AppError(502, "binance_invalid_kline", "Binance returned an invalid candle close.");
      }
      return new Decimal(close).toFixed();
    });
  }
}
