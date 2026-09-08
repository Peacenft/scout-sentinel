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

export async function buildApp(
  config: AppConfig,
  database: Database,
  integrations: {
    portfolioStateProvider?: PortfolioStateProvider;
    tradeExecutionProvider?: TradeExecutionProvider;
    binanceConnectionService?: BinanceConnectionService;
  } = {},
  runtime: {
    serveStatic?: boolean;
  } = {}
): Promise<FastifyInstance> {
  const binanceConnectionService = integrations.binanceConnectionService ?? new BinanceConnectionService(database, config);
  const app = Fastify({
    logger: {
      level: config.nodeEnv === "production" ? "info" : "debug",
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "req.headers['x-bootstrap-token']", "res.headers['set-cookie']"],
        censor: "[REDACTED]"
      }
    },
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: "x-request-id",
    trustProxy: config.nodeEnv === "production"
  });

  app.decorateRequest("authenticatedUser", null);
  app.decorateRequest("sessionToken", null);
  app.addHook("onRequest", async (request) => {
    request.log.info({
      req: {
        method: request.method,
        url: request.url.split("?")[0],
        host: request.hostname,
        remoteAddress: request.ip
      }
    }, "incoming request");
  });
  app.addHook("onResponse", async (request, reply) => {
    request.log.info({ res: { statusCode: reply.statusCode } }, "request completed");
  });
  await app.register(cookie);
  await app.register(helmet);
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    allowList: (request) => {
      if (request.method !== "GET" && request.method !== "HEAD") return false;
      const path = request.url.split("?")[0] ?? "";
      return path === "/" || path.startsWith("/assets/");
    }
  });

  await registerOAuthRoutes(app, database, config);

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

  await registerAuthRoutes(app, database, config);
  await registerBinanceRoutes(app, database, config, binanceConnectionService);
  await registerMandateRoutes(app, database, config);
  await registerAuditRoutes(app, database, config);
  await registerEvaluationRoutes(app, database, config, integrations.portfolioStateProvider);
  await registerConfirmationRoutes(app, database, config);
  await registerExecutionRoutes(app, database, config, {
    ...(integrations.portfolioStateProvider ? { portfolio: integrations.portfolioStateProvider } : {}),
    ...(integrations.tradeExecutionProvider ? { execution: integrations.tradeExecutionProvider } : {})
  });
  await registerMcpRoutes(app, database, config, {
    ...(integrations.portfolioStateProvider ? { portfolio: integrations.portfolioStateProvider } : {}),
    ...(integrations.tradeExecutionProvider ? { execution: integrations.tradeExecutionProvider } : {})
  }, binanceConnectionService);

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
    await app.register(fastifyStatic, { root: webRoot, prefix: "/", wildcard: false });
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
    request.log.error({ err: error }, "request failed");
    return reply.code(500).send({
      error: { code: "internal_error", message: "The request could not be completed.", requestId: request.id }
    });
  });

  return app;
}
