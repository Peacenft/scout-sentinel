import { httpServerHandler } from "cloudflare:node";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/pool.js";

let handlerPromise: Promise<ExportedHandler<Env>> | undefined;

function createHandler(workerEnv: Env): Promise<ExportedHandler<Env>> {
  handlerPromise ??= (async () => {
    const config = loadConfig({
      NODE_ENV: workerEnv.NODE_ENV,
      HOST: workerEnv.HOST,
      PORT: workerEnv.PORT,
      DATABASE_URL: workerEnv.HYPERDRIVE.connectionString,
      SESSION_PEPPER: workerEnv.SESSION_PEPPER,
      BOOTSTRAP_ADMIN_TOKEN: workerEnv.BOOTSTRAP_ADMIN_TOKEN,
      ALLOWED_ORIGINS: workerEnv.ALLOWED_ORIGINS,
      PUBLIC_BASE_URL: workerEnv.PUBLIC_BASE_URL,
      BINANCE_MCP_URL: workerEnv.BINANCE_MCP_URL,
      BINANCE_AUTHORIZATION_SERVER_URL: workerEnv.BINANCE_AUTHORIZATION_SERVER_URL,
      BINANCE_TOKEN_ENCRYPTION_KEY: workerEnv.BINANCE_TOKEN_ENCRYPTION_KEY,
      STATE_MAX_AGE_SECONDS: workerEnv.STATE_MAX_AGE_SECONDS,
      MONITOR_INTERVAL_SECONDS: workerEnv.MONITOR_INTERVAL_SECONDS
    });
    const database = createDatabase(config.databaseUrl);
    const app = await buildApp(config, database, {}, { serveStatic: false });
    await app.listen({ port: config.port });
    return httpServerHandler({ port: config.port });
  })();
  return handlerPromise;
}

export default {
  async fetch(
    request: Request<unknown, IncomingRequestCfProperties<unknown>>,
    workerEnv: Env,
    context: ExecutionContext
  ): Promise<Response> {
    const handler = await createHandler(workerEnv);
    if (!handler.fetch) return new Response("Worker handler unavailable", { status: 500 });
    return handler.fetch(request, workerEnv, context);
  }
} satisfies ExportedHandler<Env>;
