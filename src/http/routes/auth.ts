import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import type { Database } from "../../db/pool.js";
import { AppError } from "../../errors.js";
import { authenticateSession, bootstrapAdmin, createSession, restoreDashboardSession, revokeSession } from "../../services/auth.js";
import { extractSessionToken, requireAuthentication } from "../authenticate.js";

const credentialsSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(12).max(200)
});

const dashboardAccessSchema = z.object({ token: z.string().min(32).max(500) }).strict();

function setSessionCookie(reply: import("fastify").FastifyReply, config: AppConfig, session: { token: string; expiresAt: string }): void {
  reply.setCookie("ss_session", session.token, {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "strict",
    path: "/",
    expires: new Date(session.expiresAt)
  });
}

export function registerAuthRoutes(app: FastifyInstance, database: Database, config: AppConfig): void {
  app.post("/v1/auth/bootstrap", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const input = credentialsSchema.parse(request.body);
    const bootstrapToken = request.headers["x-bootstrap-token"];
    if (typeof bootstrapToken !== "string") throw new AppError(403, "bootstrap_forbidden", "The bootstrap token is required.");
    const user = await bootstrapAdmin(database, config.bootstrapAdminToken, bootstrapToken, input.email, input.password);
    return reply.code(201).send({ user });
  });

  app.post("/v1/auth/login", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const input = credentialsSchema.parse(request.body);
    const session = await createSession(database, config.sessionPepper, input.email, input.password);
    setSessionCookie(reply, config, session);
    return { user: session.user, expiresAt: session.expiresAt };
  });

  app.post("/v1/auth/agent-access", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const input = dashboardAccessSchema.parse(request.body);
    const session = await restoreDashboardSession(database, config.sessionPepper, input.token);
    setSessionCookie(reply, config, session);
    return { user: session.user, expiresAt: session.expiresAt };
  });

  app.post("/v1/auth/logout", { preHandler: requireAuthentication(database, config) }, async (request, reply) => {
    if (request.sessionToken) await revokeSession(database, config.sessionPepper, request.sessionToken);
    reply.clearCookie("ss_session", { path: "/" });
    return reply.code(204).send();
  });

  app.get("/v1/auth/me", async (request, reply) => {
    const token = extractSessionToken(request.headers.authorization, request.cookies.ss_session);
    if (!token) return { user: null };
    try {
      return { user: await authenticateSession(database, config.sessionPepper, token) };
    } catch (error) {
      if (!(error instanceof AppError) || error.statusCode !== 401) throw error;
      reply.clearCookie("ss_session", { path: "/" });
      return { user: null };
    }
  });
}
