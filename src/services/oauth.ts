import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Database } from "../db/pool.js";
import { inTransaction } from "../db/transaction.js";
import { AppError } from "../errors.js";
import { canonicalJson, randomToken, tokenHash } from "../security/crypto.js";
import { appendAuditEvent } from "./audit.js";
import type pg from "pg";

export const supportedAgentScopes = [
  "sentinel:read",
  "sentinel:evaluate",
  "sentinel:confirmations",
  "sentinel:execute"
] as const;

export type AgentScope = (typeof supportedAgentScopes)[number];

const clientMetadataSchema = z.object({
  redirect_uris: z.array(z.url()).min(1).max(10),
  token_endpoint_auth_method: z.literal("none").optional(),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).optional(),
  response_types: z.array(z.literal("code")).optional(),
  client_name: z.string().trim().min(1).max(120).optional(),
  client_uri: z.url().optional(),
  logo_uri: z.union([z.url(), z.literal("")]).optional(),
  scope: z.string().max(500).optional(),
  contacts: z.array(z.email()).max(10).optional(),
  tos_uri: z.union([z.url(), z.literal("")]).optional(),
  policy_uri: z.url().optional(),
  software_id: z.string().max(200).optional(),
  software_version: z.string().max(100).optional()
}).strip();

export type OAuthClientMetadata = z.infer<typeof clientMetadataSchema>;

export type OAuthClient = OAuthClientMetadata & {
  client_id: string;
  client_id_issued_at: number;
  token_endpoint_auth_method: "none";
  grant_types: Array<"authorization_code" | "refresh_token">;
  response_types: ["code"];
};

export type AuthorizationRequest = {
  id: string;
  clientId: string;
  clientName: string;
  userId: string | null;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scopes: AgentScope[];
  resource: string;
  expiresAt: string;
};

export type AgentAccess = {
  token: string;
  clientId: string;
  userId: string;
  scopes: AgentScope[];
  resource: string;
  expiresAt: string;
};

export type AgentConnection = {
  clientId: string;
  clientName: string;
  scopes: AgentScope[];
  connectedAt: string;
  expiresAt: string;
};

type AuthorizationRow = {
  id: string;
  client_id: string;
  user_id: string | null;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  scopes: AgentScope[];
  resource: string;
  expires_at: Date;
  client_name: string;
};

function isLoopbackUrl(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function validateRedirectUri(value: string): void {
  const url = new URL(value);
  if (url.hash) throw new AppError(400, "invalid_client_metadata", "Redirect URIs cannot contain fragments.");
  if (url.protocol !== "https:" && !isLoopbackUrl(url)) {
    throw new AppError(400, "invalid_client_metadata", "Redirect URIs must use HTTPS, except loopback callbacks.");
  }
}

function redirectUriMatches(requested: string, registered: string): boolean {
  if (requested === registered) return true;
  const requestUrl = new URL(requested);
  const registeredUrl = new URL(registered);
  if (!isLoopbackUrl(requestUrl) || !isLoopbackUrl(registeredUrl)) return false;
  return requestUrl.protocol === registeredUrl.protocol
    && requestUrl.hostname === registeredUrl.hostname
    && requestUrl.pathname === registeredUrl.pathname
    && requestUrl.search === registeredUrl.search;
}

function parseScopes(scope: string | undefined): AgentScope[] {
  const requested = scope?.trim()
    ? [...new Set(scope.trim().split(/\s+/))]
    : ["sentinel:read", "sentinel:evaluate", "sentinel:confirmations"];
  for (const item of requested) {
    if (!supportedAgentScopes.includes(item as AgentScope)) {
      throw new AppError(400, "invalid_scope", `Unsupported scope: ${item}`);
    }
  }
  return requested as AgentScope[];
}

function mapAuthorization(row: AuthorizationRow): AuthorizationRequest {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    userId: row.user_id,
    redirectUri: row.redirect_uri,
    state: row.state,
    codeChallenge: row.code_challenge,
    scopes: row.scopes,
    resource: row.resource,
    expiresAt: row.expires_at.toISOString()
  };
}

export async function registerOAuthClient(database: Database, input: unknown): Promise<OAuthClient> {
  const metadata = clientMetadataSchema.parse(input);
  metadata.redirect_uris.forEach(validateRedirectUri);
  if (metadata.grant_types && !metadata.grant_types.includes("authorization_code")) {
    throw new AppError(400, "invalid_client_metadata", "The authorization_code grant is required.");
  }
  if (metadata.scope) parseScopes(metadata.scope);
  const client: OAuthClient = {
    ...metadata,
    client_id: randomToken(24),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: "none",
    grant_types: metadata.grant_types ?? ["authorization_code", "refresh_token"],
    response_types: ["code"]
  };
  await database.query(
    "INSERT INTO oauth_clients(client_id, metadata) VALUES ($1, $2::jsonb)",
    [client.client_id, canonicalJson(client)]
  );
  return client;
}

export async function beginAuthorization(input: {
  database: Database;
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope?: string;
  state?: string;
  resource?: string;
  expectedResource: string;
  userId?: string;
}): Promise<AuthorizationRequest> {
  if (input.responseType !== "code") throw new AppError(400, "unsupported_response_type", "Only the code response type is supported.");
  if (!URL.canParse(input.redirectUri)) throw new AppError(400, "invalid_request", "A valid redirect URI is required.");
  if (input.codeChallengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(input.codeChallenge)) {
    throw new AppError(400, "invalid_request", "A valid S256 PKCE challenge is required.");
  }
  const clientResult = await input.database.query<{ metadata: OAuthClient }>(
    "SELECT metadata FROM oauth_clients WHERE client_id = $1",
    [input.clientId]
  );
  const client = clientResult.rows[0]?.metadata;
  if (!client) throw new AppError(400, "invalid_client", "The OAuth client is not registered.");
  if (!client.redirect_uris.some((registered) => redirectUriMatches(input.redirectUri, registered))) {
    throw new AppError(400, "invalid_request", "The redirect URI is not registered.");
  }
  const resource = input.resource ?? input.expectedResource;
  if (resource !== input.expectedResource) throw new AppError(400, "invalid_target", "The requested resource is not this MCP server.");
  const scopes = parseScopes(input.scope);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const created = await input.database.query<AuthorizationRow>(
    `INSERT INTO oauth_authorization_requests(
       client_id, user_id, redirect_uri, state, code_challenge, scopes, resource, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, client_id, user_id, redirect_uri, state, code_challenge, scopes, resource, expires_at,
       COALESCE((SELECT metadata->>'client_name' FROM oauth_clients WHERE client_id = $1), 'Agent client') AS client_name`,
    [input.clientId, input.userId ?? null, input.redirectUri, input.state ?? null, input.codeChallenge, scopes, resource, expiresAt]
  );
  const row = created.rows[0];
  if (!row) throw new AppError(500, "authorization_create_failed", "The authorization request could not be saved.");
  return mapAuthorization(row);
}

export async function getAuthorizationRequest(database: Database, requestId: string, userId?: string): Promise<AuthorizationRequest> {
  const result = await database.query<AuthorizationRow>(
    `SELECT oauth_authorization_requests.id, oauth_authorization_requests.client_id,
            oauth_authorization_requests.user_id, redirect_uri, state, code_challenge, scopes,
            resource, expires_at, COALESCE(oauth_clients.metadata->>'client_name', 'Agent client') AS client_name
       FROM oauth_authorization_requests
       JOIN oauth_clients USING (client_id)
      WHERE oauth_authorization_requests.id = $1 AND decided_at IS NULL AND expires_at > now()`,
    [requestId]
  );
  const row = result.rows[0];
  if (!row) throw new AppError(400, "invalid_request", "The authorization request is invalid or expired.");
  if (userId && row.user_id && row.user_id !== userId) throw new AppError(403, "authorization_forbidden", "This authorization request belongs to another user.");
  if (userId && !row.user_id) {
    const bound = await database.query("UPDATE oauth_authorization_requests SET user_id = $2 WHERE id = $1 AND user_id IS NULL RETURNING id", [requestId, userId]);
    if (bound.rowCount !== 1) throw new AppError(409, "authorization_claimed", "This authorization request was opened in another session.");
    row.user_id = userId;
  }
  return mapAuthorization(row);
}

export async function decideAuthorization(input: {
  database: Database;
  pepper: string;
  requestId: string;
  userId?: string;
  approved: boolean;
}): Promise<string> {
  return inTransaction(input.database, async (client) => {
    const result = await client.query<AuthorizationRow>(
      `SELECT oauth_authorization_requests.id, oauth_authorization_requests.client_id,
              oauth_authorization_requests.user_id, redirect_uri, state, code_challenge, scopes,
              resource, expires_at, COALESCE(oauth_clients.metadata->>'client_name', 'Agent client') AS client_name
         FROM oauth_authorization_requests
         JOIN oauth_clients USING (client_id)
        WHERE oauth_authorization_requests.id = $1
        FOR UPDATE OF oauth_authorization_requests`,
      [input.requestId]
    );
    const authorization = result.rows[0];
    if (!authorization || authorization.expires_at.getTime() <= Date.now()) {
      throw new AppError(400, "invalid_request", "The authorization request is invalid or expired.");
    }
    if (authorization.user_id !== (input.userId ?? null)) throw new AppError(403, "authorization_forbidden", "This authorization request belongs to another user.");
    const consumed = await client.query(
      "UPDATE oauth_authorization_requests SET decided_at = now() WHERE id = $1 AND decided_at IS NULL RETURNING id",
      [input.requestId]
    );
    if (consumed.rowCount !== 1) throw new AppError(409, "authorization_decided", "This authorization request has already been decided.");

    const redirect = new URL(authorization.redirect_uri);
    if (!input.approved) {
      redirect.searchParams.set("error", "access_denied");
      if (authorization.state) redirect.searchParams.set("state", authorization.state);
      return redirect.toString();
    }

    if (!input.userId) throw new AppError(401, "login_required", "A private workspace is required before granting access.");

    const code = randomToken();
    await client.query(
      `INSERT INTO oauth_authorization_codes(
         code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        tokenHash(code, input.pepper), authorization.client_id, input.userId,
        authorization.redirect_uri, authorization.code_challenge, authorization.scopes,
        authorization.resource, new Date(Date.now() + 5 * 60 * 1000)
      ]
    );
    await appendAuditEvent(client, {
      userId: input.userId,
      eventType: "oauth.access_granted",
      aggregateType: "user",
      aggregateId: input.userId,
      payload: { clientId: authorization.client_id, clientName: authorization.client_name, scopes: authorization.scopes }
    });
    redirect.searchParams.set("code", code);
    if (authorization.state) redirect.searchParams.set("state", authorization.state);
    return redirect.toString();
  });
}

function verifyPkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const calculated = createHash("sha256").update(verifier).digest("base64url");
  const left = Buffer.from(calculated);
  const right = Buffer.from(challenge);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function issueTokens(input: {
  database: Database | pg.PoolClient;
  pepper: string;
  clientId: string;
  userId: string;
  scopes: AgentScope[];
  resource: string;
}): Promise<{ access_token: string; token_type: "Bearer"; expires_in: number; scope: string; refresh_token: string }> {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const accessTtlSeconds = 60 * 60;
  await input.database.query("DELETE FROM oauth_access_tokens WHERE expires_at < now() - interval '7 days'");
  await input.database.query("DELETE FROM oauth_refresh_tokens WHERE expires_at < now() - interval '7 days'");
  await input.database.query(
    `INSERT INTO oauth_access_tokens(token_hash, client_id, user_id, scopes, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
    [tokenHash(accessToken, input.pepper), input.clientId, input.userId, input.scopes, input.resource, accessTtlSeconds]
  );
  await input.database.query(
    `INSERT INTO oauth_refresh_tokens(token_hash, client_id, user_id, scopes, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '30 days')`,
    [tokenHash(refreshToken, input.pepper), input.clientId, input.userId, input.scopes, input.resource]
  );
  return { access_token: accessToken, token_type: "Bearer", expires_in: accessTtlSeconds, scope: input.scopes.join(" "), refresh_token: refreshToken };
}

export async function exchangeAuthorizationCode(input: {
  database: Database;
  pepper: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri?: string;
  resource?: string;
}): Promise<{ access_token: string; token_type: "Bearer"; expires_in: number; scope: string; refresh_token: string }> {
  return inTransaction(input.database, async (client) => {
    const result = await client.query<{
      id: string; user_id: string; redirect_uri: string; code_challenge: string; scopes: AgentScope[]; resource: string;
    }>(
      `SELECT id, user_id, redirect_uri, code_challenge, scopes, resource
         FROM oauth_authorization_codes
        WHERE code_hash = $1 AND client_id = $2 AND used_at IS NULL AND expires_at > now()
        FOR UPDATE`,
      [tokenHash(input.code, input.pepper), input.clientId]
    );
    const code = result.rows[0];
    if (!code || !verifyPkce(input.codeVerifier, code.code_challenge)) throw new AppError(400, "invalid_grant", "The authorization code is invalid.");
    if (input.redirectUri && input.redirectUri !== code.redirect_uri) throw new AppError(400, "invalid_grant", "The redirect URI does not match.");
    if (input.resource && input.resource !== code.resource) throw new AppError(400, "invalid_target", "The resource does not match.");
    await client.query("UPDATE oauth_authorization_codes SET used_at = now() WHERE id = $1", [code.id]);
    return issueTokens({ database: client, pepper: input.pepper, clientId: input.clientId, userId: code.user_id, scopes: code.scopes, resource: code.resource });
  });
}

export async function exchangeRefreshToken(input: {
  database: Database;
  pepper: string;
  clientId: string;
  refreshToken: string;
  requestedScope?: string;
  resource?: string;
}): Promise<{ access_token: string; token_type: "Bearer"; expires_in: number; scope: string; refresh_token: string }> {
  return inTransaction(input.database, async (client) => {
    const result = await client.query<{
      id: string; user_id: string; scopes: AgentScope[]; resource: string;
    }>(
      `SELECT id, user_id, scopes, resource FROM oauth_refresh_tokens
        WHERE token_hash = $1 AND client_id = $2 AND revoked_at IS NULL AND expires_at > now()
        FOR UPDATE`,
      [tokenHash(input.refreshToken, input.pepper), input.clientId]
    );
    const current = result.rows[0];
    if (!current) throw new AppError(400, "invalid_grant", "The refresh token is invalid.");
    const scopes = input.requestedScope ? parseScopes(input.requestedScope) : current.scopes;
    if (scopes.some((scope) => !current.scopes.includes(scope))) throw new AppError(400, "invalid_scope", "Refresh cannot add scopes.");
    if (input.resource && input.resource !== current.resource) throw new AppError(400, "invalid_target", "The resource does not match.");
    await client.query("UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE id = $1", [current.id]);
    return issueTokens({ database: client, pepper: input.pepper, clientId: input.clientId, userId: current.user_id, scopes, resource: current.resource });
  });
}

export async function verifyAgentAccess(database: Database, pepper: string, token: string, expectedResource: string): Promise<AgentAccess> {
  const result = await database.query<{
    client_id: string; user_id: string; scopes: AgentScope[]; resource: string; expires_at: Date;
  }>(
    `SELECT oauth_access_tokens.client_id, oauth_access_tokens.user_id, scopes, resource, oauth_access_tokens.expires_at
       FROM oauth_access_tokens
       JOIN users ON users.id = oauth_access_tokens.user_id
      WHERE token_hash = $1 AND oauth_access_tokens.revoked_at IS NULL
        AND oauth_access_tokens.expires_at > now() AND users.disabled_at IS NULL`,
    [tokenHash(token, pepper)]
  );
  const access = result.rows[0];
  if (!access || access.resource !== expectedResource) throw new AppError(401, "invalid_token", "The access token is invalid or expired.");
  return {
    token,
    clientId: access.client_id,
    userId: access.user_id,
    scopes: access.scopes,
    resource: access.resource,
    expiresAt: access.expires_at.toISOString()
  };
}

export async function listAgentConnections(database: Database, userId: string): Promise<AgentConnection[]> {
  const result = await database.query<{
    client_id: string;
    client_name: string;
    scopes: AgentScope[];
    created_at: Date;
    expires_at: Date;
  }>(
    `SELECT DISTINCT ON (oauth_refresh_tokens.client_id)
            oauth_refresh_tokens.client_id,
            COALESCE(oauth_clients.metadata->>'client_name', 'Agent client') AS client_name,
            oauth_refresh_tokens.scopes,
            oauth_refresh_tokens.created_at,
            oauth_refresh_tokens.expires_at
       FROM oauth_refresh_tokens
       JOIN oauth_clients USING (client_id)
      WHERE oauth_refresh_tokens.user_id = $1
        AND oauth_refresh_tokens.revoked_at IS NULL
        AND oauth_refresh_tokens.expires_at > now()
      ORDER BY oauth_refresh_tokens.client_id, oauth_refresh_tokens.created_at DESC`,
    [userId]
  );
  return result.rows.map((row) => ({
    clientId: row.client_id,
    clientName: row.client_name,
    scopes: row.scopes,
    connectedAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString()
  }));
}

export async function revokeOAuthToken(database: Database, pepper: string, clientId: string, token: string): Promise<void> {
  const hash = tokenHash(token, pepper);
  await inTransaction(database, async (client) => {
    await client.query(
      "UPDATE oauth_access_tokens SET revoked_at = now() WHERE token_hash = $1 AND client_id = $2 AND revoked_at IS NULL",
      [hash, clientId]
    );
    await client.query(
      "UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND client_id = $2 AND revoked_at IS NULL",
      [hash, clientId]
    );
  });
}

export async function assertOAuthClient(database: Database, clientId: string): Promise<void> {
  const result = await database.query("SELECT 1 FROM oauth_clients WHERE client_id = $1", [clientId]);
  if (result.rowCount !== 1) throw new AppError(401, "invalid_client", "The OAuth client is invalid.");
}
