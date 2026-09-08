import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import type { Database } from "./db/pool.js";
import { AppError } from "./errors.js";
import { registerAuthRoutes } from "./http/routes/auth.js";
import { registerAuditRoutes } from "./http/routes/audit.js";
import { registerConfirmationRoutes } from "./http/routes/confirmations.js";
import { requireAuthentication } from "./http/authenticate.js";
import { registerMandateRoutes } from "./http/routes/mandates.js";
import { registerEvaluationRoutes } from "./http/routes/evaluations.js";
import type { PortfolioStateProvider } from "./integrations/portfolio-state-provider.js";
import type { TradeExecutionProvider } from "./integrations/trade-execution-provider.js";
import { registerExecutionRoutes } from "./http/routes/executions.js";
import { startMonitorWorker } from "./services/monitoring.js";
import { registerOAuthRoutes } from "./http/routes/oauth.js";
import { registerMcpRoutes } from "./http/routes/mcp.js";
import { listAgentConnections } from "./services/oauth.js";
import { registerBinanceRoutes } from "./http/routes/binance.js";
import { BinanceConnectionService } from "./services/binance-connection.js";

export function buildApp(
  config: AppConfig,
  database: Database,
  integrations: {
    portfolioStateProvider?: PortfolioStateProvider;
    tradeExecutionProvider?: TradeExecutionProvider;
    binanceConnectionService?: BinanceConnectionService;
  } = {},
  runtime: {
    serveStatic?: boolean;
    useConsoleLogger?: boolean;
  } = {}
): FastifyInstance {
  const binanceConnectionService = integrations.binanceConnectionService ?? new BinanceConnectionService(database, config);
  const consoleLogger = runtime.useConsoleLogger ? {
    info(value: unknown, message: string) {
      console.log(JSON.stringify({ level: "info", time: new Date().toISOString(), value, message }));
    },
    warn(value: unknown, message: string) {
      console.warn(JSON.stringify({ level: "warn", time: new Date().toISOString(), value, message }));
    },
    error(value: unknown, message: string) {
      console.error(JSON.stringify({ level: "error", time: new Date().toISOString(), value, message }));
    }
  } : undefined;
  const app = Fastify({
    logger: runtime.useConsoleLogger ? false : {
      level: config.nodeEnv === "production" ? "info" : "debug",
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "req.headers['x-bootstrap-token']", "res.headers['set-cookie']"],
        censor: "[REDACTED]"
      }
    },
    logController: new LogController({ disableRequestLogging: true }),
    pluginTimeout: runtime.useConsoleLogger ? 0 : 10_000,
    requestIdHeader: "x-request-id",
    trustProxy: config.nodeEnv === "production"
  });

  app.decorateRequest("authenticatedUser", null);
  app.decorateRequest("sessionToken", null);
  app.addHook("onRequest", async (request) => {
    const entry = {
      req: {
        method: request.method,
        url: request.url.split("?")[0],
        host: request.hostname,
        remoteAddress: request.ip
      }
    };
    if (consoleLogger) consoleLogger.info({ requestId: request.id, ...entry }, "incoming request");
    else request.log.info(entry, "incoming request");
  });
  app.addHook("onResponse", async (request, reply) => {
    const entry = { requestId: request.id, res: { statusCode: reply.statusCode } };
    if (consoleLogger) consoleLogger.info(entry, "request completed");
    else request.log.info(entry, "request completed");
  });
  app.register(cookie);
  app.register(helmet);
  app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    allowList: (request) => {
      if (request.method !== "GET" && request.method !== "HEAD") return false;
      const path = request.url.split("?")[0] ?? "";
      return path === "/" || path.startsWith("/assets/");
    }
  });

  registerOAuthRoutes(app, database, config);

  app.addHook("onRequest", async (request) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    if (["/oauth/register", "/oauth/token", "/oauth/revoke", "/mcp"].includes(request.url.split("?")[0] ?? "")) return;
    const origin = request.headers.origin;
    if (origin && !config.allowedOrigins.has(origin)) {
      throw new AppError(403, "origin_forbidden", "The request origin is not allowed.");
    }
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    await database.query("SELECT 1");
    return reply.send({ status: "ready" });
  });

  registerAuthRoutes(app, database, config);
  registerBinanceRoutes(app, database, config, binanceConnectionService);
  registerMandateRoutes(app, database, config);
  registerAuditRoutes(app, database, config);
  registerEvaluationRoutes(app, database, config, integrations.portfolioStateProvider);
  registerConfirmationRoutes(app, database, config);
  registerExecutionRoutes(app, database, config, {
    ...(integrations.portfolioStateProvider ? { portfolio: integrations.portfolioStateProvider } : {}),
    ...(integrations.tradeExecutionProvider ? { execution: integrations.tradeExecutionProvider } : {})
  });
  registerMcpRoutes(app, database, config, {
    ...(integrations.portfolioStateProvider ? { portfolio: integrations.portfolioStateProvider } : {}),
    ...(integrations.tradeExecutionProvider ? { execution: integrations.tradeExecutionProvider } : {})
  }, binanceConnectionService, consoleLogger);

  if (config.nodeEnv !== "test" && integrations.portfolioStateProvider) {
    let stopMonitor: (() => void) | undefined;
    app.addHook("onReady", async () => {
      stopMonitor = startMonitorWorker({
        database,
        provider: integrations.portfolioStateProvider as PortfolioStateProvider,
        intervalSeconds: config.monitorIntervalSeconds,
        stateMaxAgeSeconds: config.stateMaxAgeSeconds,
        logger: app.log
      });
    });
    app.addHook("onClose", async () => stopMonitor?.());
  }

  app.get("/v1/capabilities", { preHandler: requireAuthentication(database, config) }, async (request) => {
    const agentConnections = await listAgentConnections(database, request.authenticatedUser!.id);
    const binanceConnection = await binanceConnectionService.status(request.authenticatedUser!.id);
    return {
      binance: {
        accountState: integrations.portfolioStateProvider || binanceConnection.connected ? "connected" : "disconnected",
        portfolioState: integrations.portfolioStateProvider ? "connected" : "disabled",
        execution: integrations.tradeExecutionProvider ? "connected" : "disabled",
        monitoring: integrations.portfolioStateProvider ? "connected" : "disabled",
        oauthReady: Boolean(config.publicBaseUrl?.startsWith("https://")),
        connection: binanceConnection
      },
      agentGateway: {
        oauth: "connected",
        endpoint: `${config.publicBaseUrl ?? `http://127.0.0.1:${config.port}`}/mcp`,
        connections: agentConnections
      }
    };
  });

  const shouldServeStatic = runtime.serveStatic ?? config.nodeEnv !== "test";
  const webRoot = resolve(process.cwd(), "dist/public");
  if (shouldServeStatic && config.nodeEnv === "production" && !existsSync(webRoot)) {
    throw new Error(`Web build not found at ${webRoot}`);
  }
  if (shouldServeStatic && existsSync(webRoot)) {
    app.register(fastifyStatic, { root: webRoot, prefix: "/", wildcard: false });
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (
      shouldServeStatic &&
      request.method === "GET" &&
      !request.url.startsWith("/v1/") &&
      !request.url.startsWith("/health/") &&
      !request.url.startsWith("/oauth/") &&
      !request.url.startsWith("/.well-known/") &&
      !request.url.startsWith("/mcp") &&
      request.headers.accept?.includes("text/html")
    ) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({
      error: { code: "not_found", message: "The requested resource does not exist.", requestId: request.id }
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: { code: "validation_failed", message: "The request is invalid.", details: error.flatten(), requestId: request.id }
      });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}), requestId: request.id }
      });
    }
    if (typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 429) {
      return reply.code(429).send({
        error: { code: "rate_limit_exceeded", message: "Too many requests. Wait and try again.", requestId: request.id }
      });
    }
    const entry = { requestId: request.id, errorName: error instanceof Error ? error.name : "unknown" };
    if (consoleLogger) consoleLogger.error(entry, "request failed");
    else request.log.error({ err: error }, "request failed");
    return reply.code(500).send({
      error: { code: "internal_error", message: "The request could not be completed.", requestId: request.id }
    });
  });

  return app;
}
