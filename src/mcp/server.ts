import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/pool.js";
import { mandateSchema, proposalSchema } from "../domain/schemas.js";
import { AppError } from "../errors.js";
import type { PortfolioStateProvider } from "../integrations/portfolio-state-provider.js";
import type { TradeExecutionProvider } from "../integrations/trade-execution-provider.js";
import { confirmTerms, getConfirmationReview, requestConfirmation } from "../services/confirmations.js";
import { evaluateWithTrustedState } from "../services/evaluations.js";
import { executeConfirmedTrade, getExecutionOperation, listTrackedPositions, reconcileExecution } from "../services/executions.js";
import { createMandate, getActiveMandate } from "../services/mandates.js";
import { listProtectionEvents } from "../services/monitoring.js";
import type { AgentAccess, AgentScope } from "../services/oauth.js";
import { createDashboardAccessToken } from "../services/auth.js";
import type { BinanceConnectionService } from "../services/binance-connection.js";

type Providers = { portfolio?: PortfolioStateProvider; execution?: TradeExecutionProvider };

function response(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function failure(error: unknown) {
  const body = error instanceof AppError
    ? { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }
    : { error: { code: "internal_error", message: "The tool request could not be completed." } };
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError: true };
}

function requireScope(access: AgentAccess, scope: AgentScope): void {
  if (!access.scopes.includes(scope)) throw new AppError(403, "insufficient_scope", `The ${scope} scope is required.`);
}

export function createSentinelMcpServer(input: {
  database: Database;
  config: AppConfig;
  access: AgentAccess;
  providers: Providers;
  binanceConnections: BinanceConnectionService;
  logger: FastifyBaseLogger;
}): McpServer {
  const server = new McpServer({ name: "scout-sentinel", version: "0.3.0" });
  const baseUrl = input.config.publicBaseUrl ?? `http://127.0.0.1:${input.config.port}`;

  async function runTool<T>(tool: string, scope: AgentScope, work: () => Promise<T>) {
    input.logger.info({ tool, oauthClientId: input.access.clientId, userId: input.access.userId }, "MCP tool invoked");
    try {
      requireScope(input.access, scope);
      return response(await work());
    } catch (error) {
      input.logger.warn({ tool, oauthClientId: input.access.clientId, userId: input.access.userId, errorCode: error instanceof AppError ? error.code : "internal_error" }, "MCP tool failed");
      return failure(error);
    }
  }

  server.registerTool("sentinel_status", {
    title: "Sentinel status",
    description: "Read connection status and the active risk mandate. This never submits a trade.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async () => runTool("sentinel_status", "sentinel:read", async () => {
    let mandate = null;
    try {
      mandate = await getActiveMandate(input.database, input.access.userId);
    } catch (error) {
      if (!(error instanceof AppError && error.code === "mandate_not_found")) throw error;
    }
    const binanceConnection = await input.binanceConnections.status(input.access.userId);
    return {
      dashboardUrl: baseUrl,
      mandate,
      binance: {
        accountState: input.providers.portfolio || binanceConnection.connected ? "connected" : "disconnected",
        portfolioState: input.providers.portfolio ? "connected" : "disabled",
        execution: input.providers.execution ? "connected" : "disabled",
        monitoring: input.providers.portfolio ? "connected" : "disabled",
        connection: binanceConnection
      },
      approval: "Every trade requires the user's explicit approval of the exact terms. Approval can happen in the agent or dashboard."
    };
  }));

  server.registerTool("sentinel_dashboard_link", {
    title: "Open the Sentinel dashboard",
    description: "Create a single-use, five-minute link to this agent's private Sentinel workspace. No email or password is required.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, async () => runTool("sentinel_dashboard_link", "sentinel:read", async () => {
    const access = await createDashboardAccessToken(input.database, input.config.sessionPepper, input.access.userId);
    return {
      dashboardUrl: `${baseUrl}/#access=${encodeURIComponent(access.token)}`,
      expiresAt: access.expiresAt,
      singleUse: true
    };
  }));

  server.registerTool("sentinel_binance_status", {
    title: "Binance connection status",
    description: "Read whether this private Sentinel workspace has a verified Binance account connection. No balance values or tokens are returned.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async () => runTool("sentinel_binance_status", "sentinel:read", async () => ({
    connection: await input.binanceConnections.status(input.access.userId)
  })));

  server.registerTool("sentinel_connect_binance", {
    title: "Connect Binance",
    description: "Create a ten-minute Binance authorization URL for this private Sentinel workspace. The user chooses permissions on Binance. No API key is requested.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, async () => runTool("sentinel_connect_binance", "sentinel:read", async () => (
    input.binanceConnections.begin(input.access.userId)
  )));

  server.registerTool("sentinel_disconnect_binance", {
    title: "Remove Binance access",
    description: "Delete this workspace's encrypted Binance credentials. The user should also disconnect Scout + Sentinel in Binance account settings.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  }, async () => runTool("sentinel_disconnect_binance", "sentinel:confirmations", async () => {
    await input.binanceConnections.disconnect(input.access.userId);
    return { disconnected: true, providerRevocationRequired: true };
  }));

  server.registerTool("sentinel_activate_mandate", {
    title: "Activate risk mandate",
    description: "Create and activate a new immutable mandate version only after the user explicitly approves every displayed limit. This never submits a trade.",
    inputSchema: mandateSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  }, async (document) => runTool("sentinel_activate_mandate", "sentinel:confirmations", async () => ({
    mandate: await createMandate(input.database, input.access.userId, document)
  })));

  server.registerTool("sentinel_evaluate_proposal", {
    title: "Evaluate a Scout proposal",
    description: "Evaluate one complete proposal against the active mandate and fresh trusted Binance account state.",
    inputSchema: proposalSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, async (proposal) => runTool("sentinel_evaluate_proposal", "sentinel:evaluate", async () => {
    if (!input.providers.portfolio) throw new AppError(503, "binance_not_connected", "Connect Binance Agent OS before evaluating a live proposal.");
    return {
      evaluation: await evaluateWithTrustedState({
        database: input.database,
        provider: input.providers.portfolio,
        userId: input.access.userId,
        proposal,
        stateMaxAgeSeconds: input.config.stateMaxAgeSeconds
      })
    };
  }));

  server.registerTool("sentinel_request_confirmation", {
    title: "Request trade approval",
    description: "Create a 90-second exact-terms approval for a policy-approved evaluation. The user can accept it in the agent or dashboard. This does not submit a trade.",
    inputSchema: { evaluationId: z.uuid() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, async ({ evaluationId }) => runTool("sentinel_request_confirmation", "sentinel:confirmations", async () => {
    const confirmation = await requestConfirmation(input.database, input.access.userId, evaluationId);
    return { confirmation, approvalUrl: `${baseUrl}/?confirmation=${encodeURIComponent(confirmation.id)}` };
  }));

  server.registerTool("sentinel_confirmation_status", {
    title: "Check trade approval",
    description: "Read an approval request and whether the user accepted its exact terms.",
    inputSchema: { confirmationId: z.uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async ({ confirmationId }) => runTool("sentinel_confirmation_status", "sentinel:read", async () => ({
    confirmation: await getConfirmationReview(input.database, input.access.userId, confirmationId)
  })));

  server.registerTool("sentinel_accept_confirmation", {
    title: "Accept exact trade terms",
    description: "Accept one unexpired confirmation after the user explicitly approves the displayed proposal, verdict, and exact terms hash. This does not submit a trade.",
    inputSchema: {
      confirmationId: z.uuid(),
      termsHash: z.string().regex(/^[a-f0-9]{64}$/)
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  }, async ({ confirmationId, termsHash }) => runTool("sentinel_accept_confirmation", "sentinel:confirmations", async () => ({
    confirmation: await confirmTerms(input.database, input.access.userId, confirmationId, termsHash)
  })));

  server.registerTool("sentinel_execute_confirmed", {
    title: "Execute approved trade",
    description: "Submit a trade only after the user accepted the exact, unexpired terms. Repeated calls are idempotent.",
    inputSchema: { confirmationId: z.uuid() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  }, async ({ confirmationId }) => runTool("sentinel_execute_confirmed", "sentinel:execute", async () => {
    if (!input.providers.portfolio || !input.providers.execution) {
      throw new AppError(503, "binance_execution_not_connected", "Connect the server-side Binance execution provider before submitting trades.");
    }
    return {
      operation: await executeConfirmedTrade({
        database: input.database,
        portfolioProvider: input.providers.portfolio,
        executionProvider: input.providers.execution,
        userId: input.access.userId,
        confirmationId,
        idempotencyKey: `mcp:${confirmationId}`,
        stateMaxAgeSeconds: input.config.stateMaxAgeSeconds
      })
    };
  }));

  server.registerTool("sentinel_execution_status", {
    title: "Check execution status",
    description: "Read a stored execution operation without resubmitting it.",
    inputSchema: { operationId: z.uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async ({ operationId }) => runTool("sentinel_execution_status", "sentinel:read", async () => ({
    operation: await getExecutionOperation(input.database, input.access.userId, operationId)
  })));

  server.registerTool("sentinel_reconcile_execution", {
    title: "Reconcile execution",
    description: "Ask Binance for the status of an existing pending or unknown operation. This never resubmits the order.",
    inputSchema: { operationId: z.uuid() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, async ({ operationId }) => runTool("sentinel_reconcile_execution", "sentinel:read", async () => {
    if (!input.providers.execution) throw new AppError(503, "binance_execution_not_connected", "Connect Binance before reconciling trades.");
    return {
      operation: await reconcileExecution({
        database: input.database,
        executionProvider: input.providers.execution,
        userId: input.access.userId,
        operationId
      })
    };
  }));

  server.registerTool("sentinel_positions", {
    title: "Tracked positions",
    description: "Read positions created from confirmed Binance fills and their monitor status.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async () => runTool("sentinel_positions", "sentinel:read", async () => ({
    positions: await listTrackedPositions(input.database, input.access.userId)
  })));

  server.registerTool("sentinel_protection_events", {
    title: "Protection events",
    description: "Read current drawdown and missing-position protection events.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async () => runTool("sentinel_protection_events", "sentinel:read", async () => ({
    events: await listProtectionEvents(input.database, input.access.userId)
  })));

  return server;
}
