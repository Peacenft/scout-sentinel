import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { createDatabase } from "../src/db/pool.js";
import { mandate } from "./fixtures.js";
import { portfolioState, proposal } from "./fixtures.js";
import type { PortfolioStateProvider } from "../src/integrations/portfolio-state-provider.js";
import type { TradeExecutionProvider } from "../src/integrations/trade-execution-provider.js";
import { runMonitorBatch } from "../src/services/monitoring.js";
import { createHash, randomBytes } from "node:crypto";
import { BinanceConnectionService, type BinanceAccountVerifier } from "../src/services/binance-connection.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
if (databaseUrl && !databaseUrl.endsWith("_test")) throw new Error("TEST_DATABASE_URL must target a database ending in _test");
const integrationDatabaseUrl = databaseUrl ?? "postgres://unused/disabled_test";

describeWithDatabase("HTTP and PostgreSQL integration", () => {
  const database = createDatabase(integrationDatabaseUrl);
  const config: AppConfig = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 4100,
    databaseUrl: integrationDatabaseUrl,
    sessionPepper: "integration-session-pepper-at-least-32-chars",
    bootstrapAdminToken: "integration-bootstrap-token-at-least-32-chars",
    allowedOrigins: new Set(["http://127.0.0.1:3000"]),
    stateMaxAgeSeconds: 30,
    monitorIntervalSeconds: 60
  };
  let app: Awaited<ReturnType<typeof buildApp>>;
  let connectedApp: Awaited<ReturnType<typeof buildApp>>;
  let binanceApp: Awaited<ReturnType<typeof buildApp>>;
  let sessionCookie = "";
  let agentAccessToken = "";
  let submitCount = 0;
  let exchangedVerifier = "";

  beforeAll(async () => {
    await database.query(
      "TRUNCATE oauth_refresh_tokens, oauth_access_tokens, oauth_authorization_codes, oauth_authorization_requests, oauth_clients, protection_events, monitor_jobs, tracked_positions, execution_receipts, audit_events, execution_operations, confirmation_requests, evaluations, proposals, mandates, sessions, users RESTART IDENTITY CASCADE"
    );
    app = await buildApp(config, database);
    const provider: PortfolioStateProvider = {
      providerName: "binance_agent_os",
      async getPortfolioState() {
        return { ...portfolioState, asOf: new Date().toISOString() };
      }
    };
    const executionProvider: TradeExecutionProvider = {
      providerName: "binance_agent_os",
      async submitTrade() {
        submitCount += 1;
        return {
          providerOperationId: "binance-order-1001",
          state: "confirmed",
          providerStatus: "FILLED",
          observedAt: new Date().toISOString(),
          executedBaseQuantity: "0.00025",
          executedQuoteQuantity: "20",
          evidence: { orderId: "1001", status: "FILLED" }
        };
      },
      async getTradeStatus() {
        return {
          providerOperationId: "binance-order-1001",
          state: "confirmed",
          providerStatus: "FILLED",
          observedAt: new Date().toISOString(),
          executedBaseQuantity: "0.00025",
          executedQuoteQuantity: "20",
          evidence: { orderId: "1001", status: "FILLED" }
        };
      }
    };
    connectedApp = await buildApp(config, database, { portfolioStateProvider: provider, tradeExecutionProvider: executionProvider });
    const binanceConfig: AppConfig = {
      ...config,
      publicBaseUrl: "https://sentinel.example",
      binanceMcpUrl: "https://agent.binance.example/mcp/agentic",
      binanceAuthorizationServerUrl: "https://agent.binance.example"
    };
    const verifier: BinanceAccountVerifier = {
      async verify(input) {
        expect(input).toEqual({
          mcpUrl: "https://agent.binance.example/mcp/agentic",
          accessToken: "real-provider-access-token"
        });
        return {
          schemaVersion: 1,
          accountRead: true,
          accountType: "SPOT",
          canTrade: true,
          nonZeroAssetCount: 2,
          spotTradeToolAdvertised: true,
          convertTradeToolsAdvertised: true,
          verifiedAt: "2026-09-08T12:00:00.000Z"
        };
      }
    };
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(JSON.stringify({
          issuer: "https://agent.binance.example",
          authorization_endpoint: "https://accounts.binance.example/agentic-oauth/authorize",
          token_endpoint: "https://accounts.binance.example/oauth-agentic/token",
          token_endpoint_auth_methods_supported: ["none"],
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          client_id_metadata_document_supported: true
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/oauth-agentic/token")) {
        const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init?.body ?? ""));
        expect(body.get("client_id")).toBe("https://sentinel.example/oauth/binance/client.json");
        expect(body.get("redirect_uri")).toBe("https://sentinel.example/oauth/binance/callback");
        expect(body.get("resource")).toBe("https://agent.binance.example/mcp/agentic");
        expect(body.get("code")).toBe("provider-authorization-code");
        exchangedVerifier = body.get("code_verifier") ?? "";
        return new Response(JSON.stringify({
          access_token: "real-provider-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "account trade"
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    };
    const binanceConnectionService = new BinanceConnectionService(database, binanceConfig, verifier, fakeFetch);
    binanceApp = await buildApp(binanceConfig, database, { binanceConnectionService });
  });

  afterAll(async () => {
    await app?.close();
    await connectedApp?.close();
    await binanceApp?.close();
    await database.end();
  });

  it("returns a clean signed-out session state for public visitors", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/auth/me" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: null });
  });

  it("bootstraps, authenticates, versions a mandate, and writes its audit chain", async () => {
    const bootstrap = await app.inject({
      method: "POST",
      url: "/v1/auth/bootstrap",
      headers: {
        origin: "http://127.0.0.1:3000",
        "x-bootstrap-token": config.bootstrapAdminToken
      },
      payload: { email: "operator@example.com", password: "a-strong-test-password" }
    });
    expect(bootstrap.statusCode).toBe(201);

    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { email: "operator@example.com", password: "a-strong-test-password" }
    });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
    expect(cookie).toMatch(/^ss_session=/);
    sessionCookie = cookie ?? "";

    const created = await app.inject({
      method: "POST",
      url: "/v1/mandates",
      headers: { origin: "http://127.0.0.1:3000", cookie: cookie ?? "" },
      payload: mandate
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().mandate.version).toBe(1);
    expect(created.json().mandate.documentHash).toMatch(/^[a-f0-9]{64}$/);

    const active = await app.inject({ method: "GET", url: "/v1/mandates/active", headers: { cookie: cookie ?? "" } });
    expect(active.statusCode).toBe(200);
    expect(active.json().mandate.document).toEqual(mandate);

    const audit = await database.query<{
      sequence: string;
      event_type: string;
      previous_hash: string | null;
      event_hash: string;
      created_at: Date;
      hash_version: number;
    }>(
      "SELECT sequence::text, event_type, previous_hash, event_hash, created_at, hash_version FROM audit_events ORDER BY sequence"
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual(["operator.created", "session.created", "mandate.activated"]);
    expect(audit.rows[0]?.previous_hash).toBeNull();
    expect(audit.rows[1]?.previous_hash).toBe(audit.rows[0]?.event_hash);
    expect(audit.rows[2]?.previous_hash).toBe(audit.rows[1]?.event_hash);
    expect(audit.rows.every((row) => row.hash_version === 2)).toBe(true);

    const integrity = await app.inject({ method: "GET", url: "/v1/audit/integrity", headers: { cookie: cookie ?? "" } });
    expect(integrity.statusCode).toBe(200);
    expect(integrity.json().integrity).toEqual({ valid: true, eventCount: 3, brokenAt: null });

    const firstEvent = audit.rows[0];
    expect(firstEvent).toBeTruthy();
    await database.query("UPDATE audit_events SET created_at = created_at + interval '1 second' WHERE sequence = $1", [firstEvent?.sequence]);
    const tampered = await app.inject({ method: "GET", url: "/v1/audit/integrity", headers: { cookie: cookie ?? "" } });
    expect(tampered.json().integrity).toEqual({ valid: false, eventCount: 3, brokenAt: firstEvent?.sequence });
    await database.query("UPDATE audit_events SET created_at = $1 WHERE sequence = $2", [firstEvent?.created_at, firstEvent?.sequence]);
    const restored = await app.inject({ method: "GET", url: "/v1/audit/integrity", headers: { cookie: cookie ?? "" } });
    expect(restored.json().integrity).toEqual({ valid: true, eventCount: 3, brokenAt: null });
  });

  it("rejects mutations from an untrusted browser origin", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { origin: "https://attacker.example" },
      payload: { email: "operator@example.com", password: "a-strong-test-password" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("origin_forbidden");
  });

  it("completes OAuth PKCE and protects the MCP endpoint", async () => {
    const registered = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: {
        client_name: "Integration agent",
        redirect_uris: ["http://127.0.0.1:7777/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"]
      }
    });
    expect(registered.statusCode).toBe(201);
    const clientId = registered.json().client_id as string;
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorized = await app.inject({
      method: "GET",
      url: `/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent("http://127.0.0.1:45678/callback")}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&scope=${encodeURIComponent("sentinel:read sentinel:evaluate sentinel:confirmations sentinel:execute")}&state=test-state&resource=${encodeURIComponent("http://127.0.0.1:4100/mcp")}`,
      headers: { cookie: sessionCookie }
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.headers["content-type"]).toContain("text/html");
    const requestId = authorized.body.match(/name="request_id" value="([a-f0-9-]+)"/)?.[1];
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/);

    const decision = await app.inject({
      method: "POST",
      url: "/oauth/authorize/decision",
      headers: { origin: "http://127.0.0.1:3000", cookie: sessionCookie, "content-type": "application/x-www-form-urlencoded" },
      payload: `request_id=${encodeURIComponent(requestId ?? "")}&decision=approve`
    });
    expect(decision.statusCode).toBe(302);
    const callback = new URL(decision.headers.location ?? "http://invalid");
    expect(callback.searchParams.get("state")).toBe("test-state");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { origin: "http://127.0.0.1:3000", "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: code ?? "",
        code_verifier: verifier,
        redirect_uri: "http://127.0.0.1:45678/callback",
        resource: "http://127.0.0.1:4100/mcp"
      }).toString()
    });
    expect(token.statusCode).toBe(200);
    expect(token.json().access_token).toBeTruthy();
    expect(token.json().refresh_token).toBeTruthy();
    expect(token.json().scope).toBe("sentinel:read sentinel:evaluate sentinel:confirmations sentinel:execute");
    agentAccessToken = token.json().access_token as string;

    const capabilities = await app.inject({ method: "GET", url: "/v1/capabilities", headers: { cookie: sessionCookie } });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json().agentGateway.connections).toEqual([
      expect.objectContaining({
        clientId,
        clientName: "Integration agent",
        scopes: ["sentinel:read", "sentinel:evaluate", "sentinel:confirmations", "sentinel:execute"]
      })
    ]);

    const replay = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { origin: "http://127.0.0.1:3000", "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: code ?? "",
        code_verifier: verifier
      }).toString()
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe("invalid_grant");

    const unauthorizedMcp = await app.inject({ method: "POST", url: "/mcp", payload: {} });
    expect(unauthorizedMcp.statusCode).toBe(401);
    expect(unauthorizedMcp.headers["www-authenticate"]).toContain("oauth-protected-resource/mcp");

    const initialized = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${token.json().access_token}`, accept: "application/json, text/event-stream" },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "integration-client", version: "1.0.0" } }
      }
    });
    expect(initialized.statusCode).toBe(200);
    expect(initialized.json().result.serverInfo.name).toBe("scout-sentinel");

    const tools = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${token.json().access_token}`, accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
    });
    expect(tools.statusCode).toBe(200);
    const toolNames = tools.json().result.tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining([
      "sentinel_connect_binance",
      "sentinel_binance_status",
      "sentinel_activate_mandate",
      "sentinel_accept_confirmation",
      "sentinel_execute_confirmed"
    ]));

    const status = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${token.json().access_token}`, accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "sentinel_status", arguments: {} } }
    });
    expect(status.statusCode).toBe(200);
    expect(JSON.parse(status.json().result.content[0].text).binance.execution).toBe("disabled");
  });

  it("connects one workspace to Binance with PKCE and encrypted token storage", async () => {
    const localStart = await app.inject({
      method: "POST",
      url: "/v1/binance/connect",
      headers: { origin: "http://127.0.0.1:3000", cookie: sessionCookie }
    });
    expect(localStart.statusCode).toBe(503);
    expect(localStart.json().error.code).toBe("binance_public_https_required");

    const metadata = await binanceApp.inject({ method: "GET", url: "/oauth/binance/client.json" });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toEqual(expect.objectContaining({
      client_id: "https://sentinel.example/oauth/binance/client.json",
      redirect_uris: ["https://sentinel.example/oauth/binance/callback"],
      token_endpoint_auth_method: "none"
    }));

    const started = await binanceApp.inject({
      method: "POST",
      url: "/v1/binance/connect",
      headers: { origin: "http://127.0.0.1:3000", cookie: sessionCookie }
    });
    expect(started.statusCode).toBe(201);
    const authorizationUrl = new URL(started.json().authorizationUrl);
    expect(authorizationUrl.origin).toBe("https://accounts.binance.example");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("https://sentinel.example/oauth/binance/client.json");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("resource")).toBe("https://agent.binance.example/mcp/agentic");
    const state = authorizationUrl.searchParams.get("state") ?? "";
    const challenge = authorizationUrl.searchParams.get("code_challenge") ?? "";

    const callback = await binanceApp.inject({
      method: "GET",
      url: `/oauth/binance/callback?code=provider-authorization-code&state=${encodeURIComponent(state)}`
    });
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe("/?binance=connected");
    expect(createHash("sha256").update(exchangedVerifier).digest("base64url")).toBe(challenge);

    const status = await binanceApp.inject({ method: "GET", url: "/v1/binance/connection", headers: { cookie: sessionCookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json().connection).toEqual(expect.objectContaining({ connected: true, status: "connected" }));
    expect(status.json().connection.capabilities).toEqual(expect.objectContaining({ accountRead: true, nonZeroAssetCount: 2 }));

    const otherUserStatus = await new BinanceConnectionService(database, {
      ...config,
      publicBaseUrl: "https://sentinel.example"
    }).status("00000000-0000-4000-8000-000000000001");
    expect(otherUserStatus).toEqual(expect.objectContaining({ connected: false, status: "disconnected" }));

    const stored = await database.query<{ token_ciphertext: string }>("SELECT token_ciphertext FROM binance_connections LIMIT 1");
    expect(stored.rows[0]?.token_ciphertext).toMatch(/^v1\./);
    expect(stored.rows[0]?.token_ciphertext).not.toContain("real-provider-access-token");

    const replay = await binanceApp.inject({
      method: "GET",
      url: `/oauth/binance/callback?code=provider-authorization-code&state=${encodeURIComponent(state)}`
    });
    expect(replay.statusCode).toBe(303);
    expect(replay.headers.location).toContain("binance_oauth_state_invalid");

    const disconnected = await binanceApp.inject({
      method: "DELETE",
      url: "/v1/binance/connection",
      headers: { origin: "http://127.0.0.1:3000", cookie: sessionCookie }
    });
    expect(disconnected.statusCode).toBe(204);
    const after = await binanceApp.inject({ method: "GET", url: "/v1/binance/connection", headers: { cookie: sessionCookie } });
    expect(after.json().connection).toEqual(expect.objectContaining({ connected: false, status: "disconnected" }));
  });

  it("creates an isolated agent workspace without signup and restores dashboard access once", async () => {
    const registered = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: {
        client_name: "Passwordless agent",
        redirect_uris: ["http://127.0.0.1:7788/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"]
      }
    });
    const clientId = registered.json().client_id as string;
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorization = await app.inject({
      method: "GET",
      url: `/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent("http://127.0.0.1:7788/callback")}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&scope=sentinel%3Aread&state=passwordless&resource=${encodeURIComponent("http://127.0.0.1:4100/mcp")}`
    });
    expect(authorization.statusCode).toBe(200);
    expect(authorization.body).toContain("No email or password is required");
    expect(authorization.body).not.toContain('type="email"');
    const requestId = authorization.body.match(/name="request_id" value="([a-f0-9-]+)"/)?.[1];

    const decision = await app.inject({
      method: "POST",
      url: "/oauth/authorize/decision",
      headers: { origin: "http://127.0.0.1:3000", "content-type": "application/x-www-form-urlencoded" },
      payload: `request_id=${encodeURIComponent(requestId ?? "")}&decision=approve`
    });
    expect(decision.statusCode).toBe(302);
    const setCookie = decision.headers["set-cookie"];
    const workspaceCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0] ?? "";
    expect(workspaceCookie).toMatch(/^ss_session=/);

    const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: workspaceCookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toEqual(expect.objectContaining({ email: null, identityType: "agent" }));

    const callback = new URL(decision.headers.location ?? "http://invalid");
    const token = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { origin: "http://127.0.0.1:3000", "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: callback.searchParams.get("code") ?? "",
        code_verifier: verifier,
        redirect_uri: "http://127.0.0.1:7788/callback",
        resource: "http://127.0.0.1:4100/mcp"
      }).toString()
    });
    expect(token.statusCode).toBe(200);

    const link = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${token.json().access_token}`, accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "sentinel_dashboard_link", arguments: {} } }
    });
    expect(link.statusCode).toBe(200);
    const linkResult = JSON.parse(link.json().result.content[0].text) as { dashboardUrl: string; singleUse: boolean };
    expect(linkResult.singleUse).toBe(true);
    const accessToken = new URLSearchParams(new URL(linkResult.dashboardUrl).hash.slice(1)).get("access");
    expect(accessToken).toBeTruthy();

    const restored = await app.inject({
      method: "POST",
      url: "/v1/auth/agent-access",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { token: accessToken }
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().user.id).toBe(me.json().user.id);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/auth/agent-access",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { token: accessToken }
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe("dashboard_access_invalid");
  });

  it("fails closed when Binance account state is unavailable", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sentinel/evaluate",
      headers: { origin: "http://127.0.0.1:3000", cookie: sessionCookie },
      payload: {}
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("binance_not_connected");
  });

  it("evaluates with trusted provider state and binds a single-use confirmation", async () => {
    const observedAt = new Date().toISOString();
    const candidate = proposal({
      id: "b0a16997-e5e0-4adc-8787-177fc662fafe",
      createdAt: observedAt,
      marketSnapshot: { ...proposal().marketSnapshot, observedAt }
    });
    const evaluated = await connectedApp.inject({
      method: "POST",
      url: "/v1/sentinel/evaluate",
      headers: { origin: "http://127.0.0.1:3000", cookie: sessionCookie },
      payload: candidate
    });
    expect(evaluated.statusCode).toBe(201);
    expect(evaluated.json().evaluation.verdict.decision).toBe("APPROVED_NEEDS_USER");
    const evaluationId = evaluated.json().evaluation.id as string;

    const requested = await connectedApp.inject({
      method: "POST",
      url: `/v1/evaluations/${evaluationId}/confirmation`,
      headers: { origin: "http://127.0.0.1:3000", cookie: sessionCookie }
    });
    expect(requested.statusCode).toBe(201);
    const confirmation = requested.json().confirmation as { id: string; termsHash: string };

    const wrongTerms = await connectedApp.inject({
      method: "POST",
      url: `/v1/confirmations/${confirmation.id}/accept`,
      headers: { origin: "http://127.0.0.1:3000", cookie: sessionCookie },
      payload: { termsHash: "0".repeat(64) }
    });
    expect(wrongTerms.statusCode).toBe(409);
    expect(wrongTerms.json().error.code).toBe("confirmation_terms_changed");

    const accepted = await connectedApp.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${agentAccessToken}`, accept: "application/json, text/event-stream" },
      payload: {
        jsonrpc: "2.0",
        id: 40,
        method: "tools/call",
        params: {
          name: "sentinel_accept_confirmation",
          arguments: { confirmationId: confirmation.id, termsHash: confirmation.termsHash }
        }
      }
    });
    expect(accepted.statusCode).toBe(200);
    expect(JSON.parse(accepted.json().result.content[0].text).confirmation.confirmedAt).toBeTruthy();

    const replay = await connectedApp.inject({
      method: "POST",
      url: `/v1/confirmations/${confirmation.id}/accept`,
      headers: { origin: "http://127.0.0.1:3000", cookie: sessionCookie },
      payload: { termsHash: confirmation.termsHash }
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe("confirmation_already_used");

    const executed = await connectedApp.inject({
      method: "POST",
      url: `/v1/confirmations/${confirmation.id}/execute`,
      headers: { origin: "http://127.0.0.1:3000", cookie: sessionCookie },
      payload: { idempotencyKey: "integration-order-0001" }
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json().operation.status).toBe("confirmed");
    expect(executed.json().operation.providerOperationId).toBe("binance-order-1001");
    const operationId = executed.json().operation.id as string;

    const retried = await connectedApp.inject({
      method: "POST",
      url: `/v1/confirmations/${confirmation.id}/execute`,
      headers: { origin: "http://127.0.0.1:3000", cookie: sessionCookie },
      payload: { idempotencyKey: "integration-order-0001" }
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().operation.id).toBe(operationId);
    expect(submitCount).toBe(1);

    const stored = await connectedApp.inject({
      method: "GET",
      url: `/v1/executions/${operationId}`,
      headers: { cookie: sessionCookie }
    });
    expect(stored.statusCode).toBe(200);
    expect(stored.json().operation.status).toBe("confirmed");

    const positions = await connectedApp.inject({ method: "GET", url: "/v1/positions", headers: { cookie: sessionCookie } });
    expect(positions.statusCode).toBe(200);
    expect(positions.json().positions).toEqual([
      expect.objectContaining({
        sourceOperationId: operationId,
        baseAsset: "BTC",
        quoteAsset: "USDC",
        openedBaseQuantity: "0.00025",
        openedQuoteQuantity: "20",
        status: "active"
      })
    ]);

    const monitor = await database.query<{ status: string }>("SELECT status FROM monitor_jobs WHERE position_id = $1", [positions.json().positions[0].id]);
    expect(monitor.rows[0]?.status).toBe("active");

    const protectionProvider: PortfolioStateProvider = {
      providerName: "binance_agent_os",
      async getPortfolioState() {
        return { ...portfolioState, asOf: new Date().toISOString(), unrealizedPnlUsd: "-20" };
      }
    };
    const firstMonitorRun = await runMonitorBatch({
      database,
      provider: protectionProvider,
      workerId: "integration-monitor-1",
      intervalSeconds: 60,
      stateMaxAgeSeconds: 30
    });
    expect(firstMonitorRun).toEqual({ claimed: 1, checked: 1, eventsCreated: 1, failed: 0 });

    await database.query("UPDATE monitor_jobs SET next_run_at = now() WHERE position_id = $1", [positions.json().positions[0].id]);
    const secondMonitorRun = await runMonitorBatch({
      database,
      provider: protectionProvider,
      workerId: "integration-monitor-2",
      intervalSeconds: 60,
      stateMaxAgeSeconds: 30
    });
    expect(secondMonitorRun.eventsCreated).toBe(0);

    const events = await connectedApp.inject({ method: "GET", url: "/v1/protection-events", headers: { cookie: sessionCookie } });
    expect(events.statusCode).toBe(200);
    expect(events.json().events).toEqual([
      expect.objectContaining({ positionId: positions.json().positions[0].id, eventType: "drawdown_threshold", status: "action_required" })
    ]);

    const finalIntegrity = await connectedApp.inject({ method: "GET", url: "/v1/audit/integrity", headers: { cookie: sessionCookie } });
    expect(finalIntegrity.statusCode).toBe(200);
    expect(finalIntegrity.json().integrity).toEqual(expect.objectContaining({ valid: true, brokenAt: null }));
    expect(finalIntegrity.json().integrity.eventCount).toBeGreaterThanOrEqual(10);
  });
});
