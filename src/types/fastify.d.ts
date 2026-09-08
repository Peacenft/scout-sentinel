import "fastify";
import type { AuthenticatedUser } from "../services/auth.js";

declare module "fastify" {
  interface FastifyRequest {
    authenticatedUser: AuthenticatedUser | null;
    sessionToken: string | null;
  }
}
