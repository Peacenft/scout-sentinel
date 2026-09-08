import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const productionEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://example.invalid/scout_sentinel",
  SESSION_PEPPER: "production-session-pepper-at-least-32-chars",
  BOOTSTRAP_ADMIN_TOKEN: "production-bootstrap-token-at-least-32-chars",
  PUBLIC_BASE_URL: "https://sentinel.example",
  ALLOWED_ORIGINS: "https://sentinel.example"
};

describe("production configuration", () => {
  it("requires a dedicated Binance token-encryption key", () => {
    expect(() => loadConfig(productionEnv)).toThrow(/BINANCE_TOKEN_ENCRYPTION_KEY/);
  });

  it("rejects malformed Binance token-encryption keys", () => {
    expect(() => loadConfig({ ...productionEnv, BINANCE_TOKEN_ENCRYPTION_KEY: "not-a-key" })).toThrow(/BINANCE_TOKEN_ENCRYPTION_KEY/);
  });

  it("accepts a canonical 32-byte base64 key", () => {
    const config = loadConfig({
      ...productionEnv,
      BINANCE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64")
    });
    expect(config.binanceTokenEncryptionKey).toBe(Buffer.alloc(32, 7).toString("base64"));
  });
});
