import type { preHandlerHookHandler } from "fastify";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/pool.js";
import { AppError } from "../errors.js";
import { authenticateSession } from "../services/auth.js";

export function extractSessionToken(authorization: string | undefined, cookieToken: string | undefined): string | null {
  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length).trim();
  return cookieToken ?? null;
}

export function requireAuthentication(database: Database, config: AppConfig): preHandlerHookHandler {
  return async (request) => {
    const token = extractSessionToken(request.headers.authorization, request.cookies.ss_session);
    if (!token) throw new AppError(401, "unauthorized", "A valid session is required.");
    request.authenticatedUser = await authenticateSession(database, config.sessionPepper, token);
    request.sessionToken = token;
  };
}

export function requireUserId(request: { authenticatedUser: { id: string } | null }): string {
  if (!request.authenticatedUser) throw new AppError(401, "unauthorized", "A valid session is required.");
  return request.authenticatedUser.id;
}
