import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import type { Database } from "../../db/pool.js";
import { confirmTerms, getConfirmationReview, listPendingConfirmations, requestConfirmation } from "../../services/confirmations.js";
import { requireAuthentication, requireUserId } from "../authenticate.js";

const idParamsSchema = z.object({ id: z.uuid() });
const confirmSchema = z.object({ termsHash: z.string().regex(/^[a-f0-9]{64}$/) });

export async function registerConfirmationRoutes(app: FastifyInstance, database: Database, config: AppConfig): Promise<void> {
  const auth = requireAuthentication(database, config);
  app.post("/v1/evaluations/:id/confirmation", { preHandler: auth }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const confirmation = await requestConfirmation(database, requireUserId(request), id);
    return reply.code(201).send({ confirmation });
  });

  app.post("/v1/confirmations/:id/accept", { preHandler: auth }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const { termsHash } = confirmSchema.parse(request.body);
    return { confirmation: await confirmTerms(database, requireUserId(request), id, termsHash) };
  });

  app.get("/v1/confirmations/pending", { preHandler: auth }, async (request) => ({
    confirmations: await listPendingConfirmations(database, requireUserId(request))
  }));

  app.get("/v1/confirmations/:id", { preHandler: auth }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return { confirmation: await getConfirmationReview(database, requireUserId(request), id) };
  });
}
