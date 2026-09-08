import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  DATABASE_URL: z.string().min(1),
  SESSION_PEPPER: z.string().min(32),
  BOOTSTRAP_ADMIN_TOKEN: z.string().min(32),
  ALLOWED_ORIGINS: z.string().default("http://127.0.0.1:3000"),
  PUBLIC_BASE_URL: z.url().optional(),
  BINANCE_MCP_URL: z.url().default("https://agent.binance.com/mcp/agentic"),
  BINANCE_AUTHORIZATION_SERVER_URL: z.url().default("https://agent.binance.com"),
  BINANCE_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  STATE_MAX_AGE_SECONDS: z.coerce.number().int().min(1).max(300).default(30),
  MONITOR_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(60)
}).superRefine((value, context) => {
  if (value.NODE_ENV === "production" && !value.PUBLIC_BASE_URL) {
    context.addIssue({ code: "custom", path: ["PUBLIC_BASE_URL"], message: "is required in production" });
  }
  if (value.NODE_ENV === "production" && value.PUBLIC_BASE_URL && !value.PUBLIC_BASE_URL.startsWith("https://")) {
    context.addIssue({ code: "custom", path: ["PUBLIC_BASE_URL"], message: "must use HTTPS in production" });
  }
  if (value.NODE_ENV === "production" && !value.BINANCE_TOKEN_ENCRYPTION_KEY) {
    context.addIssue({ code: "custom", path: ["BINANCE_TOKEN_ENCRYPTION_KEY"], message: "is required in production" });
  }
  if (value.BINANCE_TOKEN_ENCRYPTION_KEY) {
    const decoded = Buffer.from(value.BINANCE_TOKEN_ENCRYPTION_KEY, "base64");
    if (decoded.length !== 32 || decoded.toString("base64") !== value.BINANCE_TOKEN_ENCRYPTION_KEY) {
      context.addIssue({ code: "custom", path: ["BINANCE_TOKEN_ENCRYPTION_KEY"], message: "must be a canonical base64-encoded 32-byte key" });
    }
  }
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  sessionPepper: string;
  bootstrapAdminToken: string;
  allowedOrigins: ReadonlySet<string>;
  publicBaseUrl?: string;
  binanceMcpUrl?: string;
  binanceAuthorizationServerUrl?: string;
  binanceTokenEncryptionKey?: string;
  stateMaxAgeSeconds: number;
  monitorIntervalSeconds: number;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = configSchema.parse(env);
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    sessionPepper: parsed.SESSION_PEPPER,
    bootstrapAdminToken: parsed.BOOTSTRAP_ADMIN_TOKEN,
    allowedOrigins: new Set(parsed.ALLOWED_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean)),
    ...(parsed.PUBLIC_BASE_URL ? { publicBaseUrl: parsed.PUBLIC_BASE_URL.replace(/\/$/, "") } : {}),
    binanceMcpUrl: parsed.BINANCE_MCP_URL.replace(/\/$/, ""),
    binanceAuthorizationServerUrl: parsed.BINANCE_AUTHORIZATION_SERVER_URL.replace(/\/$/, ""),
    ...(parsed.BINANCE_TOKEN_ENCRYPTION_KEY ? { binanceTokenEncryptionKey: parsed.BINANCE_TOKEN_ENCRYPTION_KEY } : {}),
    stateMaxAgeSeconds: parsed.STATE_MAX_AGE_SECONDS,
    monitorIntervalSeconds: parsed.MONITOR_INTERVAL_SECONDS
  };
}
