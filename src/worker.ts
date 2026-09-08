import { env } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";
import { buildApp } from "./app.js";
import { loadWorkerConfig } from "./config.js";
import { createLazyDatabase } from "./db/pool.js";

const config = loadWorkerConfig({
  NODE_ENV: env.NODE_ENV,
  HOST: env.HOST,
  PORT: env.PORT,
  SESSION_PEPPER: env.SESSION_PEPPER,
  BOOTSTRAP_ADMIN_TOKEN: env.BOOTSTRAP_ADMIN_TOKEN,
  ALLOWED_ORIGINS: env.ALLOWED_ORIGINS,
  PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
  BINANCE_MCP_URL: env.BINANCE_MCP_URL,
  BINANCE_AUTHORIZATION_SERVER_URL: env.BINANCE_AUTHORIZATION_SERVER_URL,
  BINANCE_TOKEN_ENCRYPTION_KEY: env.BINANCE_TOKEN_ENCRYPTION_KEY,
  STATE_MAX_AGE_SECONDS: env.STATE_MAX_AGE_SECONDS,
  MONITOR_INTERVAL_SECONDS: env.MONITOR_INTERVAL_SECONDS
});
const database = createLazyDatabase(() => env.HYPERDRIVE.connectionString);
const app = buildApp(config, database, {}, { serveStatic: false, useConsoleLogger: true });
app.listen({ port: config.port });

export default httpServerHandler({ port: config.port });
