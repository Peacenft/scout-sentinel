import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import type { Database } from "../../db/pool.js";
import { listAuditEvents, verifyAuditChain } from "../../services/audit.js";
import { requireAuthentication, requireUserId } from "../authenticate.js";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  beforeSequence: z.string().regex(/^\d+$/).optional()
});

export function registerAuditRoutes(app: FastifyInstance, database: Database, config: AppConfig): void {
  const auth = requireAuthentication(database, config);
  app.get("/v1/audit", { preHandler: auth }, async (request) => {
    const query = querySchema.parse(request.query);
    const events = await listAuditEvents(database, requireUserId(request), query.limit, query.beforeSequence);
    return { events, nextBeforeSequence: events.at(-1)?.sequence ?? null };
  });

  app.get("/v1/audit/integrity", { preHandler: auth }, async (request) => ({
    integrity: await verifyAuditChain(database, requireUserId(request))
  }));
}
