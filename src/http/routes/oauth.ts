import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import type { Database } from "../../db/pool.js";
import { AppError } from "../../errors.js";
import { authenticateSession, createAgentWorkspaceSession } from "../../services/auth.js";
import {
  assertOAuthClient,
  beginAuthorization,
  decideAuthorization,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  getAuthorizationRequest,
  registerOAuthClient,
  revokeOAuthToken,
  supportedAgentScopes
} from "../../services/oauth.js";

const authorizationQuerySchema = z.object({
  request_id: z.uuid().optional(),
  client_id: z.string().min(1).optional(),
  redirect_uri: z.url().optional(),
  response_type: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  scope: z.string().optional(),
  state: z.string().max(2000).optional(),
  resource: z.url().optional()
}).strict();

const decisionSchema = z.object({
  request_id: z.uuid(),
  decision: z.enum(["approve", "deny"])
}).strict();

const tokenSchema = z.object({
  grant_type: z.enum(["authorization_code", "refresh_token"]),
  client_id: z.string().min(1),
  code: z.string().min(1).optional(),
  code_verifier: z.string().min(1).optional(),
  redirect_uri: z.url().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  resource: z.url().optional()
}).strict();

const revokeSchema = z.object({
  client_id: z.string().min(1),
  token: z.string().min(1),
  token_type_hint: z.string().optional()
}).strict();

function oauthError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AppError) {
    const status = error.statusCode >= 500 ? 500 : 400;
    return reply.code(status).header("cache-control", "no-store").send({ error: error.code, error_description: error.message });
  }
  throw error;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
}

function consentPage(request: Awaited<ReturnType<typeof getAuthorizationRequest>>, hasWorkspace: boolean): string {
  const permissions = request.scopes.map((scope) => `<li>${escapeHtml(scope.replace("sentinel:", ""))}</li>`).join("");
  const workspace = hasWorkspace
    ? "This agent will use your current private workspace."
    : "Allowing creates a private Sentinel workspace in this browser. No email or password is required.";
  return page("Allow agent access", `<p><strong>${escapeHtml(request.clientName)}</strong> wants to connect to Scout + Sentinel.</p><p>${workspace}</p><p>Requested permissions:</p><ul>${permissions}</ul><p>Trades still require your exact, expiring approval in the agent or optional dashboard.</p><form method="post" action="/oauth/authorize/decision"><input type="hidden" name="request_id" value="${escapeHtml(request.id)}"><button type="submit" name="decision" value="approve">Allow and continue</button><button type="submit" name="decision" value="deny">Deny</button></form>`);
}

async function optionalSessionUser(request: FastifyRequest, database: Database, config: AppConfig): Promise<string | undefined> {
  const token = request.cookies.ss_session;
  if (!token) return undefined;
  try {
    return (await authenticateSession(database, config.sessionPepper, token)).id;
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 401) return undefined;
    throw error;
  }
}

export function registerOAuthRoutes(app: FastifyInstance, database: Database, config: AppConfig): void {
  const baseUrl = config.publicBaseUrl ?? `http://127.0.0.1:${config.port}`;
  const resource = `${baseUrl}/mcp`;

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(typeof body === "string" ? body : body.toString("utf8"))));
    } catch (error) {
      done(error as Error);
    }
  });

  const authorizationMetadata = {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    scopes_supported: supportedAgentScopes,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"]
  };
  const protectedResourceMetadata = {
    resource,
    authorization_servers: [baseUrl],
    scopes_supported: supportedAgentScopes,
    bearer_methods_supported: ["header"],
    resource_name: "Scout + Sentinel"
  };

  app.get("/.well-known/oauth-authorization-server", async () => authorizationMetadata);
  app.get("/.well-known/oauth-protected-resource", async () => protectedResourceMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", async () => protectedResourceMetadata);

  for (const path of ["/oauth/register", "/oauth/token", "/oauth/revoke"] as const) {
    app.options(path, async (_request, reply) => reply
      .header("access-control-allow-origin", "*")
      .header("access-control-allow-methods", "POST, OPTIONS")
      .header("access-control-allow-headers", "authorization, content-type")
      .code(204).send());
  }

  app.post("/oauth/register", { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }, async (request, reply) => {
    try {
      const client = await registerOAuthClient(database, request.body);
      return reply.code(201).header("cache-control", "no-store").header("access-control-allow-origin", "*").send(client);
    } catch (error) {
      return oauthError(reply, error);
    }
  });

  app.get("/oauth/authorize", { config: { rateLimit: { max: 100, timeWindow: "15 minutes" } } }, async (request, reply) => {
    try {
      const query = authorizationQuerySchema.parse(request.query);
      const userId = await optionalSessionUser(request, database, config);
      const authorization = query.request_id
        ? await getAuthorizationRequest(database, query.request_id, userId)
        : await beginAuthorization({
            database,
            clientId: query.client_id ?? "",
            redirectUri: query.redirect_uri ?? "",
            responseType: query.response_type ?? "",
            codeChallenge: query.code_challenge ?? "",
            codeChallengeMethod: query.code_challenge_method ?? "",
            ...(query.scope ? { scope: query.scope } : {}),
            ...(query.state ? { state: query.state } : {}),
            ...(query.resource ? { resource: query.resource } : {}),
            expectedResource: resource,
            ...(userId ? { userId } : {})
          });
      return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(consentPage(authorization, Boolean(userId)));
    } catch (error) {
      return oauthError(reply, error);
    }
  });

  app.post("/oauth/authorize/decision", async (request, reply) => {
    try {
      const decision = decisionSchema.parse(request.body);
      let userId = await optionalSessionUser(request, database, config);
      if (!userId && decision.decision === "approve") {
        const session = await createAgentWorkspaceSession(database, config.sessionPepper);
        userId = session.user.id;
        reply.setCookie("ss_session", session.token, {
          httpOnly: true,
          secure: config.nodeEnv === "production",
          sameSite: "lax",
          path: "/",
          expires: new Date(session.expiresAt)
        });
        await getAuthorizationRequest(database, decision.request_id, userId);
      }
      const redirect = await decideAuthorization({
        database,
        pepper: config.sessionPepper,
        requestId: decision.request_id,
        ...(userId ? { userId } : {}),
        approved: decision.decision === "approve"
      });
      return reply.redirect(redirect);
    } catch (error) {
      return oauthError(reply, error);
    }
  });

  app.post("/oauth/token", { config: { rateLimit: { max: 50, timeWindow: "15 minutes" } } }, async (request, reply) => {
    try {
      const input = tokenSchema.parse(request.body);
      await assertOAuthClient(database, input.client_id);
      const tokens = input.grant_type === "authorization_code"
        ? await exchangeAuthorizationCode({
            database,
            pepper: config.sessionPepper,
            clientId: input.client_id,
            code: input.code ?? "",
            codeVerifier: input.code_verifier ?? "",
            ...(input.redirect_uri ? { redirectUri: input.redirect_uri } : {}),
            ...(input.resource ? { resource: input.resource } : {})
          })
        : await exchangeRefreshToken({
            database,
            pepper: config.sessionPepper,
            clientId: input.client_id,
            refreshToken: input.refresh_token ?? "",
            ...(input.scope ? { requestedScope: input.scope } : {}),
            ...(input.resource ? { resource: input.resource } : {})
          });
      return reply.header("cache-control", "no-store").header("access-control-allow-origin", "*").send(tokens);
    } catch (error) {
      return oauthError(reply, error);
    }
  });

  app.post("/oauth/revoke", async (request, reply) => {
    try {
      const input = revokeSchema.parse(request.body);
      await assertOAuthClient(database, input.client_id);
      await revokeOAuthToken(database, config.sessionPepper, input.client_id, input.token);
      return reply.code(200).header("access-control-allow-origin", "*").send();
    } catch (error) {
      return oauthError(reply, error);
    }
  });
}
