import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import type { Database } from "../../db/pool.js";
import { AppError } from "../../errors.js";
import { BinanceConnectionService } from "../../services/binance-connection.js";
import { requireAuthentication, requireUserId } from "../authenticate.js";

const callbackSchema = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(32).max(500).optional(),
  error: z.string().max(200).optional()
}).passthrough();

export async function registerBinanceRoutes(
  app: FastifyInstance,
  database: Database,
  config: AppConfig,
  service: BinanceConnectionService
): Promise<void> {
  const auth = requireAuthentication(database, config);

  app.get("/oauth/binance/client.json", async (_request, reply) => reply
    .header("cache-control", "public, max-age=300")
    .send(service.clientMetadata()));

  app.post("/v1/binance/connect", {
    preHandler: auth,
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } }
  }, async (request, reply) => reply.code(201).send(await service.begin(requireUserId(request))));

  app.get("/oauth/binance/callback", async (request, reply) => {
    const query = callbackSchema.parse(request.query);
    if (query.error) return reply.redirect("/?binance=denied", 303);
    if (!query.code || !query.state) return reply.redirect("/?binance=invalid", 303);
    try {
      await service.finish(query.state, query.code);
      return reply.redirect("/?binance=connected", 303);
    } catch (error) {
      request.log.warn({ errorCode: error instanceof AppError ? error.code : "internal_error" }, "Binance OAuth callback failed");
      return reply.redirect(`/?binance=error&code=${encodeURIComponent(error instanceof AppError ? error.code : "internal_error")}`, 303);
    }
  });

  app.get("/v1/binance/connection", { preHandler: auth }, async (request) => ({
    connection: await service.status(requireUserId(request))
  }));

  app.delete("/v1/binance/connection", { preHandler: auth }, async (request, reply) => {
    await service.disconnect(requireUserId(request));
    return reply.code(204).send();
  });
}
