import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/pool.js";
import { inTransaction } from "../db/transaction.js";
import { AppError } from "../errors.js";
import { decryptSecret, encryptSecret, randomToken, tokenHash } from "../security/crypto.js";
import { appendAuditEvent } from "./audit.js";

const FLOW_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

const authorizationMetadataSchema = z.object({
  issuer: z.url(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  response_types_supported: z.array(z.string()),
  grant_types_supported: z.array(z.string()),
  code_challenge_methods_supported: z.array(z.string()),
  client_id_metadata_document_supported: z.literal(true)
}).passthrough();

const oauthTokensSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.coerce.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional()
}).passthrough();

const accountSchema = z.object({
  balances: z.array(z.object({
    asset: z.string().min(1),
    free: z.string(),
    locked: z.string()
  }).passthrough()),
  canTrade: z.boolean().optional(),
  accountType: z.string().optional()
}).passthrough();

export type BinanceCapabilityEvidence = {
  schemaVersion: 1;
  accountRead: true;
  accountType: string | null;
  canTrade: boolean | null;
  nonZeroAssetCount: number;
  spotTradeToolAdvertised: boolean;
  convertTradeToolsAdvertised: boolean;
  verifiedAt: string;
};

export type BinanceConnectionStatus = {
  connected: boolean;
  status: "disconnected" | "connected" | "expired" | "error";
  connectedAt: string | null;
  lastVerifiedAt: string | null;
  expiresAt: string | null;
  lastErrorCode: string | null;
  capabilities: BinanceCapabilityEvidence | null;
};

export interface BinanceAccountVerifier {
  verify(input: { mcpUrl: string; accessToken: string }): Promise<BinanceCapabilityEvidence>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function extractToolResult(value: unknown): unknown {
  const top = asRecord(value);
  if (!top) return value;
  const structured = asRecord(top.structuredContent);
  if (structured) return structured.result ?? structured;
  if (Array.isArray(top.content)) {
    for (const part of top.content) {
      const record = asRecord(part);
      if (record?.type === "text" && typeof record.text === "string") {
        try {
          const parsed = JSON.parse(record.text) as unknown;
          const parsedRecord = asRecord(parsed);
          return parsedRecord?.result ?? parsed;
        } catch {
          continue;
        }
      }
    }
  }
  return top.result ?? top;
}

export class McpBinanceAccountVerifier implements BinanceAccountVerifier {
  async verify(input: { mcpUrl: string; accessToken: string }): Promise<BinanceCapabilityEvidence> {
    const client = new Client({ name: "scout-sentinel", version: "0.3.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(input.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${input.accessToken}` } }
    });
    try {
      await client.connect(transport as unknown as Parameters<typeof client.connect>[0], { timeout: REQUEST_TIMEOUT_MS });
      const names = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: REQUEST_TIMEOUT_MS });
        for (const tool of page.tools) names.add(tool.name);
        cursor = page.nextCursor;
      } while (cursor);
      if (!names.has("spot.getAccount")) {
        throw new AppError(503, "binance_account_capability_missing", "Binance did not grant the required Spot account read capability.");
      }
      const rawAccount = await client.callTool(
        { name: "spot.getAccount", arguments: { omitZeroBalances: true } },
        undefined,
        { timeout: REQUEST_TIMEOUT_MS }
      );
      const parsed = accountSchema.safeParse(extractToolResult(rawAccount));
      if (!parsed.success) {
        throw new AppError(502, "binance_account_response_invalid", "Binance returned an account response that does not match the verified schema.", {
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code }))
        });
      }
      return {
        schemaVersion: 1,
        accountRead: true,
        accountType: parsed.data.accountType ?? null,
        canTrade: parsed.data.canTrade ?? null,
        nonZeroAssetCount: parsed.data.balances.length,
        spotTradeToolAdvertised: names.has("spot.newOrder"),
        convertTradeToolsAdvertised: ["convert.sendQuoteRequest", "convert.acceptQuote", "convert.orderStatus"].every((name) => names.has(name)),
        verifiedAt: new Date().toISOString()
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, "binance_account_verification_failed", "The Binance account connection could not be verified.", {
        cause: error instanceof Error ? error.name : "unknown"
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

type FlowRow = {
  id: string;
  user_id: string;
  code_verifier_ciphertext: string;
};

type ConnectionRow = {
  id: string;
  token_ciphertext: string;
  token_expires_at: Date | null;
  token_scope: string | null;
  status: "connected" | "expired" | "error";
  capability_evidence: BinanceCapabilityEvidence;
  last_verified_at: Date | null;
  last_error_code: string | null;
  connected_at: Date;
};

function normalizeProviderError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError(502, "binance_oauth_failed", "Binance authorization could not be completed.", {
    cause: error instanceof Error ? error.name : "unknown"
  });
}

export class BinanceConnectionService {
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly accountVerifier: BinanceAccountVerifier = new McpBinanceAccountVerifier(),
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  private get mcpUrl(): string {
    return this.config.binanceMcpUrl ?? "https://agent.binance.com/mcp/agentic";
  }

  private get authorizationServerUrl(): string {
    return this.config.binanceAuthorizationServerUrl ?? "https://agent.binance.com";
  }

  private requirePublicBaseUrl(): string {
    const baseUrl = this.config.publicBaseUrl;
    if (!baseUrl || (!baseUrl.startsWith("https://") && this.config.nodeEnv !== "test")) {
      throw new AppError(503, "binance_public_https_required", "Deploy Scout + Sentinel on a public HTTPS URL before connecting Binance.");
    }
    return baseUrl.replace(/\/$/, "");
  }

  clientMetadata(): Record<string, unknown> {
    const baseUrl = this.requirePublicBaseUrl();
    const clientId = `${baseUrl}/oauth/binance/client.json`;
    return {
      client_id: clientId,
      client_name: "Scout + Sentinel",
      client_uri: baseUrl,
      redirect_uris: [`${baseUrl}/oauth/binance/callback`],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    };
  }

  private async authorizationMetadata() {
    const endpoint = `${this.authorizationServerUrl}/.well-known/oauth-authorization-server`;
    let response: Response;
    try {
      response = await this.fetchFn(endpoint, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new AppError(502, "binance_oauth_discovery_failed", "Binance OAuth metadata could not be reached.", {
        cause: error instanceof Error ? error.name : "unknown"
      });
    }
    const body = await response.json().catch(() => null);
    const parsed = authorizationMetadataSchema.safeParse(body);
    if (!response.ok || !parsed.success) {
      throw new AppError(502, "binance_oauth_metadata_invalid", "Binance returned unsupported OAuth metadata.");
    }
    if (
      !parsed.data.response_types_supported.includes("code") ||
      !parsed.data.grant_types_supported.includes("authorization_code") ||
      !parsed.data.code_challenge_methods_supported.includes("S256") ||
      !(parsed.data.token_endpoint_auth_methods_supported ?? ["none"]).includes("none")
    ) {
      throw new AppError(503, "binance_oauth_capability_missing", "Binance OAuth does not currently expose the required PKCE public-client flow.");
    }
    return parsed.data;
  }

  async begin(userId: string): Promise<{ authorizationUrl: string; expiresAt: string }> {
    const baseUrl = this.requirePublicBaseUrl();
    const metadata = await this.authorizationMetadata();
    const state = randomToken(32);
    const verifier = randomToken(48);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const expiresAt = new Date(Date.now() + FLOW_TTL_MS);
    const flow = await inTransaction(this.database, async (client) => {
      await client.query("DELETE FROM binance_oauth_flows WHERE expires_at < now() - interval '1 day'");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO binance_oauth_flows(user_id, state_hash, expires_at)
         VALUES ($1, $2, $3) RETURNING id`,
        [userId, tokenHash(state, this.config.sessionPepper), expiresAt]
      );
      const id = inserted.rows[0]?.id;
      if (!id) throw new AppError(500, "binance_oauth_start_failed", "The Binance connection could not be started.");
      const ciphertext = encryptSecret(
        verifier,
        this.config.binanceTokenEncryptionKey,
        this.config.sessionPepper,
        `binance-oauth-flow:${id}:${userId}`
      );
      await client.query("UPDATE binance_oauth_flows SET code_verifier_ciphertext = $1 WHERE id = $2", [ciphertext, id]);
      await appendAuditEvent(client, {
        userId,
        eventType: "binance.connection_started",
        aggregateType: "binance_connection",
        aggregateId: id,
        payload: { expiresAt: expiresAt.toISOString() }
      });
      return { id };
    });
    const clientId = `${baseUrl}/oauth/binance/client.json`;
    const authorizationUrl = new URL(metadata.authorization_endpoint);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", clientId);
    authorizationUrl.searchParams.set("redirect_uri", `${baseUrl}/oauth/binance/callback`);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("resource", this.mcpUrl);
    void flow;
    return { authorizationUrl: authorizationUrl.toString(), expiresAt: expiresAt.toISOString() };
  }

  async finish(state: string, code: string): Promise<{ userId: string; status: BinanceConnectionStatus }> {
    const baseUrl = this.requirePublicBaseUrl();
    const flowResult = await this.database.query<FlowRow>(
      `UPDATE binance_oauth_flows
          SET consumed_at = now()
        WHERE state_hash = $1
          AND consumed_at IS NULL
          AND expires_at > now()
          AND code_verifier_ciphertext IS NOT NULL
      RETURNING id, user_id, code_verifier_ciphertext`,
      [tokenHash(state, this.config.sessionPepper)]
    );
    const flow = flowResult.rows[0];
    if (!flow) throw new AppError(400, "binance_oauth_state_invalid", "The Binance connection request is invalid or expired.");
    try {
      const verifier = decryptSecret(
        flow.code_verifier_ciphertext,
        this.config.binanceTokenEncryptionKey,
        this.config.sessionPepper,
        `binance-oauth-flow:${flow.id}:${flow.user_id}`
      );
      const metadata = await this.authorizationMetadata();
      const clientId = `${baseUrl}/oauth/binance/client.json`;
      const response = await this.fetchFn(metadata.token_endpoint, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: `${baseUrl}/oauth/binance/callback`,
          resource: this.mcpUrl
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const tokenBody = await response.json().catch(() => null);
      const parsedTokens = oauthTokensSchema.safeParse(tokenBody);
      if (!response.ok || !parsedTokens.success) {
        throw new AppError(502, "binance_token_exchange_failed", "Binance rejected the authorization code exchange.");
      }
      if (parsedTokens.data.token_type.toLowerCase() !== "bearer") {
        throw new AppError(502, "binance_token_type_invalid", "Binance returned an unsupported token type.");
      }
      const evidence = await this.accountVerifier.verify({ mcpUrl: this.mcpUrl, accessToken: parsedTokens.data.access_token });
      const expiresAt = parsedTokens.data.expires_in ? new Date(Date.now() + parsedTokens.data.expires_in * 1000) : null;
      const ciphertext = encryptSecret(
        JSON.stringify(parsedTokens.data),
        this.config.binanceTokenEncryptionKey,
        this.config.sessionPepper,
        `binance-connection:${flow.user_id}`
      );
      await inTransaction(this.database, async (client) => {
        const saved = await client.query<{ id: string }>(
          `INSERT INTO binance_connections(
             user_id, token_ciphertext, token_expires_at, token_scope, status,
             capability_evidence, last_verified_at, last_error_code
           ) VALUES ($1, $2, $3, $4, 'connected', $5::jsonb, $6, NULL)
           ON CONFLICT (user_id) DO UPDATE SET
             token_ciphertext = EXCLUDED.token_ciphertext,
             token_expires_at = EXCLUDED.token_expires_at,
             token_scope = EXCLUDED.token_scope,
             status = 'connected',
             capability_evidence = EXCLUDED.capability_evidence,
             last_verified_at = EXCLUDED.last_verified_at,
             last_error_code = NULL,
             connected_at = now(),
             updated_at = now()
           RETURNING id`,
          [flow.user_id, ciphertext, expiresAt, parsedTokens.data.scope ?? null, JSON.stringify(evidence), evidence.verifiedAt]
        );
        const connectionId = saved.rows[0]?.id;
        if (!connectionId) throw new AppError(500, "binance_connection_save_failed", "The verified Binance connection could not be saved.");
        await appendAuditEvent(client, {
          userId: flow.user_id,
          eventType: "binance.connected",
          aggregateType: "binance_connection",
          aggregateId: connectionId,
          payload: {
            verifiedAt: evidence.verifiedAt,
            accountRead: true,
            canTrade: evidence.canTrade,
            spotTradeToolAdvertised: evidence.spotTradeToolAdvertised,
            convertTradeToolsAdvertised: evidence.convertTradeToolsAdvertised
          }
        });
      });
      return { userId: flow.user_id, status: await this.status(flow.user_id) };
    } catch (error) {
      const normalized = normalizeProviderError(error);
      await inTransaction(this.database, async (client) => {
        await appendAuditEvent(client, {
          userId: flow.user_id,
          eventType: "binance.connection_failed",
          aggregateType: "binance_connection",
          aggregateId: flow.id,
          payload: { errorCode: normalized.code }
        });
      });
      throw normalized;
    }
  }

  async status(userId: string): Promise<BinanceConnectionStatus> {
    const result = await this.database.query<ConnectionRow>(
      `SELECT id, token_ciphertext, token_expires_at, token_scope, status, capability_evidence,
              last_verified_at, last_error_code, connected_at
         FROM binance_connections WHERE user_id = $1`,
      [userId]
    );
    const row = result.rows[0];
    if (!row) {
      return { connected: false, status: "disconnected", connectedAt: null, lastVerifiedAt: null, expiresAt: null, lastErrorCode: null, capabilities: null };
    }
    const expired = row.token_expires_at !== null && row.token_expires_at.getTime() <= Date.now();
    const status = expired ? "expired" : row.status;
    return {
      connected: status === "connected",
      status,
      connectedAt: row.connected_at.toISOString(),
      lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
      expiresAt: row.token_expires_at?.toISOString() ?? null,
      lastErrorCode: row.last_error_code,
      capabilities: row.capability_evidence ?? null
    };
  }

  async disconnect(userId: string): Promise<void> {
    await inTransaction(this.database, async (client) => {
      const deleted = await client.query<{ id: string }>("DELETE FROM binance_connections WHERE user_id = $1 RETURNING id", [userId]);
      const connection = deleted.rows[0];
      if (!connection) return;
      await appendAuditEvent(client, {
        userId,
        eventType: "binance.disconnected",
        aggregateType: "binance_connection",
        aggregateId: connection.id,
        payload: { localCredentialsDeleted: true, providerRevocationAvailable: false }
      });
    });
  }

  async loadTokens(userId: string): Promise<z.infer<typeof oauthTokensSchema>> {
    const result = await this.database.query<Pick<ConnectionRow, "token_ciphertext" | "token_expires_at" | "status">>(
      "SELECT token_ciphertext, token_expires_at, status FROM binance_connections WHERE user_id = $1",
      [userId]
    );
    const row = result.rows[0];
    if (!row || row.status !== "connected") throw new AppError(503, "binance_not_connected", "Connect Binance before using account tools.");
    if (row.token_expires_at && row.token_expires_at.getTime() <= Date.now()) {
      throw new AppError(401, "binance_reauthorization_required", "The Binance authorization expired. Reconnect Binance to continue.");
    }
    try {
      const value = decryptSecret(
        row.token_ciphertext,
        this.config.binanceTokenEncryptionKey,
        this.config.sessionPepper,
        `binance-connection:${userId}`
      );
      return oauthTokensSchema.parse(JSON.parse(value));
    } catch (error) {
      throw new AppError(500, "binance_token_decryption_failed", "The stored Binance authorization could not be opened.", {
        cause: error instanceof Error ? error.name : "unknown"
      });
    }
  }
}
