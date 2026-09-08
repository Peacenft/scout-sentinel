import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import type { Database } from "../../db/pool.js";
import { AppError } from "../../errors.js";
import type { PortfolioStateProvider } from "../../integrations/portfolio-state-provider.js";
import type { TradeExecutionProvider } from "../../integrations/trade-execution-provider.js";
import { executeConfirmedTrade, getExecutionOperation, listTrackedPositions, reconcileExecution } from "../../services/executions.js";
import { listProtectionEvents } from "../../services/monitoring.js";
import { requireAuthentication, requireUserId } from "../authenticate.js";

const idParamsSchema = z.object({ id: z.uuid() });
const executionRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/)
}).strict();

export async function registerExecutionRoutes(
  app: FastifyInstance,
  database: Database,
  config: AppConfig,
  providers: { portfolio?: PortfolioStateProvider; execution?: TradeExecutionProvider }
): Promise<void> {
  const auth = requireAuthentication(database, config);

  app.post("/v1/confirmations/:id/execute", { preHandler: auth }, async (request, reply) => {
    if (!providers.portfolio || !providers.execution) {
      throw new AppError(503, "binance_execution_not_connected", "Connect the server-side Binance execution provider before submitting trades.");
    }
    const { id } = idParamsSchema.parse(request.params);
    const { idempotencyKey } = executionRequestSchema.parse(request.body);
    const controller = new AbortController();
    request.raw.once("aborted", () => controller.abort());
    const operation = await executeConfirmedTrade({
      database,
      portfolioProvider: providers.portfolio,
      executionProvider: providers.execution,
      userId: requireUserId(request),
      confirmationId: id,
      idempotencyKey,
      stateMaxAgeSeconds: config.stateMaxAgeSeconds,
      signal: controller.signal
    });
    return reply.code(operation.status === "confirmed" ? 200 : 202).send({ operation });
  });

  app.get("/v1/executions/:id", { preHandler: auth }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return { operation: await getExecutionOperation(database, requireUserId(request), id) };
  });

  app.post("/v1/executions/:id/reconcile", { preHandler: auth }, async (request) => {
    if (!providers.execution) {
      throw new AppError(503, "binance_execution_not_connected", "Connect the server-side Binance execution provider before reconciling trades.");
    }
    const { id } = idParamsSchema.parse(request.params);
    const controller = new AbortController();
    request.raw.once("aborted", () => controller.abort());
    return {
      operation: await reconcileExecution({
        database,
        executionProvider: providers.execution,
        userId: requireUserId(request),
        operationId: id,
        signal: controller.signal
      })
    };
  });

  app.get("/v1/positions", { preHandler: auth }, async (request) => ({
    positions: await listTrackedPositions(database, requireUserId(request))
  }));

  app.get("/v1/protection-events", { preHandler: auth }, async (request) => ({
    events: await listProtectionEvents(database, requireUserId(request))
  }));
}
