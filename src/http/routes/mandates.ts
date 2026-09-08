import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import type { Database } from "../../db/pool.js";
import { mandateSchema } from "../../domain/schemas.js";
import { createMandate, getActiveMandate } from "../../services/mandates.js";
import { requireAuthentication, requireUserId } from "../authenticate.js";

export function registerMandateRoutes(app: FastifyInstance, database: Database, config: AppConfig): void {
  const auth = requireAuthentication(database, config);
  app.post("/v1/mandates", { preHandler: auth }, async (request, reply) => {
    const document = mandateSchema.parse(request.body);
    const mandate = await createMandate(database, requireUserId(request), document);
    return reply.code(201).send({ mandate });
  });

  app.get("/v1/mandates/active", { preHandler: auth }, async (request) => ({
    mandate: await getActiveMandate(database, requireUserId(request))
  }));
}
