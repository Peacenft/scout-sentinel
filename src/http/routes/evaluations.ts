import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import type { Database } from "../../db/pool.js";
import { proposalSchema } from "../../domain/schemas.js";
import { AppError } from "../../errors.js";
import type { PortfolioStateProvider } from "../../integrations/portfolio-state-provider.js";
import { evaluateWithTrustedState } from "../../services/evaluations.js";
import { requireAuthentication, requireUserId } from "../authenticate.js";

export async function registerEvaluationRoutes(
  app: FastifyInstance,
  database: Database,
  config: AppConfig,
  provider?: PortfolioStateProvider
): Promise<void> {
  app.post(
    "/v1/sentinel/evaluate",
    { preHandler: requireAuthentication(database, config) },
    async (request, reply) => {
      if (!provider) {
        throw new AppError(503, "binance_not_connected", "Connect Binance Agent OS before evaluating a live proposal.");
      }
      const proposal = proposalSchema.parse(request.body);
      const controller = new AbortController();
      request.raw.once("aborted", () => controller.abort());
      const evaluation = await evaluateWithTrustedState({
        database,
        provider,
        userId: requireUserId(request),
        proposal,
        stateMaxAgeSeconds: config.stateMaxAgeSeconds,
        signal: controller.signal
      });
      return reply.code(201).send({ evaluation });
    }
  );
}
