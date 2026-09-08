import { Decimal } from "decimal.js";
import type pg from "pg";
import type { Database } from "../db/pool.js";
import { mandateSchema, portfolioStateSchema, proposalSchema, verdictSchema, type PortfolioState, type Proposal, type Verdict } from "../domain/schemas.js";
import { checkExecutionGate } from "../engine/execution-gate.js";
import { evaluateProposal } from "../engine/evaluate.js";
import { AppError } from "../errors.js";
import type { PortfolioStateProvider } from "../integrations/portfolio-state-provider.js";
import {
  executionReceiptSchema,
  TradeProviderError,
  type ExecutionReceipt,
  type TradeExecutionProvider
} from "../integrations/trade-execution-provider.js";
import { canonicalJson, documentHash } from "../security/crypto.js";
import { appendAuditEvent } from "./audit.js";

export type ExecutionOperation = {
  id: string;
  confirmationId: string;
  idempotencyKey: string;
  status: "created" | "submitting" | "pending" | "confirmed" | "rejected" | "failed" | "unknown";
  provider: "binance_agent_os";
  providerOperationId: string | null;
  providerStatus: string | null;
  requestDocument: unknown;
  responseDocument: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

type ConfirmationContext = {
  confirmation_id: string;
  terms_hash: string;
  expires_at: Date;
  confirmed_at: Date | null;
  consumed_at: Date | null;
  cancelled_at: Date | null;
  evaluation_id: string;
  original_verdict: unknown;
  proposal: unknown;
  mandate_id: string;
  mandate_version: number;
  mandate: unknown;
  mandate_hash: string;
};

type OperationRow = {
  id: string;
  confirmation_id: string;
  idempotency_key: string;
  status: ExecutionOperation["status"];
  provider: "binance_agent_os";
  provider_operation_id: string | null;
  provider_status: string | null;
  request_document: unknown;
  response_document: unknown;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

function toOperation(row: OperationRow): ExecutionOperation {
  return {
    id: row.id,
    confirmationId: row.confirmation_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    provider: row.provider,
    providerOperationId: row.provider_operation_id,
    providerStatus: row.provider_status,
    requestDocument: row.request_document,
    responseDocument: row.response_document,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

const operationColumns = `id, confirmation_id, idempotency_key, status, provider, provider_operation_id,
  provider_status, request_document, response_document, error_code, error_message, created_at, updated_at`;

async function findByIdempotency(client: pg.PoolClient, userId: string, idempotencyKey: string): Promise<ExecutionOperation | null> {
  const result = await client.query<OperationRow>(
    `SELECT ${operationColumns} FROM execution_operations WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, idempotencyKey]
  );
  return result.rows[0] ? toOperation(result.rows[0]) : null;
}

async function loadConfirmation(client: pg.PoolClient, userId: string, confirmationId: string): Promise<ConfirmationContext> {
  const result = await client.query<ConfirmationContext>(
    `SELECT confirmation_requests.id AS confirmation_id, confirmation_requests.terms_hash,
            confirmation_requests.expires_at, confirmation_requests.confirmed_at,
            confirmation_requests.consumed_at, confirmation_requests.cancelled_at,
            evaluations.id AS evaluation_id, evaluations.verdict AS original_verdict,
            proposals.document AS proposal, mandates.id AS mandate_id, mandates.version AS mandate_version,
            mandates.document AS mandate, mandates.document_hash AS mandate_hash
       FROM confirmation_requests
       JOIN evaluations ON evaluations.id = confirmation_requests.evaluation_id
       JOIN proposals ON proposals.id = evaluations.proposal_id
       JOIN mandates ON mandates.id = evaluations.mandate_id AND mandates.version = evaluations.mandate_version
      WHERE confirmation_requests.id = $1 AND confirmation_requests.user_id = $2`,
    [confirmationId, userId]
  );
  const context = result.rows[0];
  if (!context) throw new AppError(404, "confirmation_not_found", "The confirmation request does not exist.");
  return context;
}

function assertConfirmationActive(context: ConfirmationContext): void {
  if (!context.confirmed_at) throw new AppError(409, "confirmation_required", "Accept the reviewed terms before execution.");
  if (context.consumed_at || context.cancelled_at) throw new AppError(409, "confirmation_inactive", "The confirmation is no longer active.");
  if (context.expires_at.getTime() <= Date.now()) throw new AppError(409, "confirmation_expired", "The confirmation expired. Evaluate the proposal again.");
}

function assertMandateUnchanged(context: ConfirmationContext, active: { id: string; version: number; document_hash: string } | undefined): void {
  if (!active || active.id !== context.mandate_id || active.version !== context.mandate_version || active.document_hash !== context.mandate_hash) {
    throw new AppError(409, "mandate_changed", "The active mandate changed after review. Evaluate the proposal again.");
  }
}

async function createOperation(input: {
  client: pg.PoolClient;
  userId: string;
  idempotencyKey: string;
  context: ConfirmationContext;
  proposal: Proposal;
  verdict: Verdict;
  portfolioState: PortfolioState;
}): Promise<ExecutionOperation> {
  await input.client.query("BEGIN");
  try {
    const locked = await input.client.query<ConfirmationContext>(
      `SELECT confirmation_requests.id AS confirmation_id, confirmation_requests.terms_hash,
              confirmation_requests.expires_at, confirmation_requests.confirmed_at,
              confirmation_requests.consumed_at, confirmation_requests.cancelled_at,
              evaluations.id AS evaluation_id, evaluations.verdict AS original_verdict,
              proposals.document AS proposal, mandates.id AS mandate_id, mandates.version AS mandate_version,
              mandates.document AS mandate, mandates.document_hash AS mandate_hash
         FROM confirmation_requests
         JOIN evaluations ON evaluations.id = confirmation_requests.evaluation_id
         JOIN proposals ON proposals.id = evaluations.proposal_id
         JOIN mandates ON mandates.id = evaluations.mandate_id AND mandates.version = evaluations.mandate_version
        WHERE confirmation_requests.id = $1 AND confirmation_requests.user_id = $2
        FOR UPDATE OF confirmation_requests`,
      [input.context.confirmation_id, input.userId]
    );
    const current = locked.rows[0];
    if (!current) throw new AppError(404, "confirmation_not_found", "The confirmation request does not exist.");
    assertConfirmationActive(current);

    const activeResult = await input.client.query<{ id: string; version: number; document_hash: string }>(
      "SELECT id, version, document_hash FROM mandates WHERE user_id = $1 AND active = true FOR UPDATE",
      [input.userId]
    );
    assertMandateUnchanged(current, activeResult.rows[0]);
    if (current.terms_hash !== input.context.terms_hash) {
      throw new AppError(409, "confirmation_terms_changed", "The confirmed terms changed. Evaluate the proposal again.");
    }

    const requestDocument = {
      evaluationId: current.evaluation_id,
      proposal: input.proposal,
      verdict: input.verdict,
      portfolioStateHash: documentHash(input.portfolioState),
      termsHash: current.terms_hash
    };
    const inserted = await input.client.query<OperationRow>(
      `INSERT INTO execution_operations(
         user_id, confirmation_id, idempotency_key, status, provider, request_document,
         mandate_id, mandate_version
       ) VALUES ($1, $2, $3, 'created', 'binance_agent_os', $4::jsonb, $5, $6)
       RETURNING ${operationColumns}`,
      [input.userId, current.confirmation_id, input.idempotencyKey, canonicalJson(requestDocument), current.mandate_id, current.mandate_version]
    );
    const row = inserted.rows[0];
    if (!row) throw new AppError(500, "execution_create_failed", "The execution operation could not be created.");
    await input.client.query("UPDATE confirmation_requests SET consumed_at = now() WHERE id = $1", [current.confirmation_id]);
    await appendAuditEvent(input.client, {
      userId: input.userId,
      eventType: "execution.created",
      aggregateType: "execution",
      aggregateId: row.id,
      payload: { confirmationId: current.confirmation_id, idempotencyKey: input.idempotencyKey, requestDocument }
    });
    await input.client.query("COMMIT");
    return toOperation(row);
  } catch (error) {
    await input.client.query("ROLLBACK");
    throw error;
  }
}

async function updateOperationFromReceipt(
  client: pg.PoolClient,
  userId: string,
  operationId: string,
  proposal: Proposal,
  receiptInput: ExecutionReceipt
): Promise<ExecutionOperation> {
  const receipt = executionReceiptSchema.parse(receiptInput);
  await client.query("BEGIN");
  try {
    const current = await client.query<OperationRow>(
      `SELECT ${operationColumns} FROM execution_operations WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [operationId, userId]
    );
    const row = current.rows[0];
    if (!row) throw new AppError(404, "execution_not_found", "The execution operation does not exist.");
    if (["confirmed", "rejected", "failed"].includes(row.status)) {
      await client.query("COMMIT");
      return toOperation(row);
    }
    if (row.provider_operation_id && row.provider_operation_id !== receipt.providerOperationId) {
      throw new AppError(502, "provider_operation_mismatch", "Binance returned a different operation ID during reconciliation.");
    }

    const updated = await client.query<OperationRow>(
      `UPDATE execution_operations
          SET status = $3, provider_operation_id = $4, provider_status = $5,
              response_document = $6::jsonb, error_code = NULL, error_message = NULL,
              last_reconciled_at = now(), updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING ${operationColumns}`,
      [operationId, userId, receipt.state, receipt.providerOperationId, receipt.providerStatus, canonicalJson(receipt)]
    );
    if (receipt.state === "confirmed") {
      await client.query(
        `INSERT INTO execution_receipts(
           operation_id, provider_operation_id, provider_status, executed_base_quantity,
           executed_quote_quantity, observed_at, evidence
         ) VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6, $7::jsonb)
         ON CONFLICT (operation_id) DO NOTHING`,
        [operationId, receipt.providerOperationId, receipt.providerStatus, receipt.executedBaseQuantity, receipt.executedQuoteQuantity, receipt.observedAt, canonicalJson(receipt.evidence)]
      );
      if (proposal.side === "BUY") {
        const position = await client.query<{ id: string }>(
          `INSERT INTO tracked_positions(
             user_id, mandate_id, mandate_version, source_operation_id, base_asset, quote_asset,
             venue, opened_base_quantity, opened_quote_quantity, opened_at
           )
           SELECT user_id, mandate_id, mandate_version, id, $3, $4, $5,
                  $6::numeric, $7::numeric, $8
             FROM execution_operations WHERE id = $1 AND user_id = $2
           ON CONFLICT (source_operation_id) DO NOTHING
           RETURNING id`,
          [operationId, userId, proposal.baseAsset, proposal.quoteAsset, proposal.venue, receipt.executedBaseQuantity, receipt.executedQuoteQuantity, receipt.observedAt]
        );
        const positionId = position.rows[0]?.id;
        if (positionId) {
          await client.query(
            `INSERT INTO monitor_jobs(user_id, position_id, next_run_at)
             VALUES ($1, $2, now()) ON CONFLICT (position_id) DO NOTHING`,
            [userId, positionId]
          );
        }
      }
    }
    await appendAuditEvent(client, {
      userId,
      eventType: `execution.${receipt.state}`,
      aggregateType: "execution",
      aggregateId: operationId,
      payload: { providerOperationId: receipt.providerOperationId, providerStatus: receipt.providerStatus, observedAt: receipt.observedAt }
    });
    await client.query("COMMIT");
    const updatedRow = updated.rows[0];
    if (!updatedRow) throw new AppError(500, "execution_update_failed", "The execution operation could not be updated.");
    return toOperation(updatedRow);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function markProviderError(
  client: pg.PoolClient,
  userId: string,
  operationId: string,
  error: unknown
): Promise<ExecutionOperation> {
  const status = error instanceof TradeProviderError && error.outcome === "rejected" ? "rejected" : "unknown";
  const rawCode = error instanceof TradeProviderError ? error.providerCode : "provider_outcome_unknown";
  const code = /^[A-Za-z0-9._:-]{1,100}$/.test(rawCode) ? rawCode : "provider_error";
  const message = status === "rejected"
    ? "Binance rejected the order. A new evaluation and confirmation are required."
    : "Binance submission did not return a provable result. Reconcile before retrying.";
  await client.query("BEGIN");
  try {
    const result = await client.query<OperationRow>(
      `UPDATE execution_operations
          SET status = $3, error_code = $4, error_message = $5, updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING ${operationColumns}`,
      [operationId, userId, status, code, message]
    );
    const row = result.rows[0];
    if (!row) throw new AppError(404, "execution_not_found", "The execution operation does not exist.");
    await appendAuditEvent(client, {
      userId,
      eventType: `execution.${status}`,
      aggregateType: "execution",
      aggregateId: operationId,
      payload: { errorCode: code }
    });
    await client.query("COMMIT");
    return toOperation(row);
  } catch (updateError) {
    await client.query("ROLLBACK");
    throw updateError;
  }
}

export async function executeConfirmedTrade(input: {
  database: Database;
  portfolioProvider: PortfolioStateProvider;
  executionProvider: TradeExecutionProvider;
  userId: string;
  confirmationId: string;
  idempotencyKey: string;
  stateMaxAgeSeconds: number;
  signal?: AbortSignal;
}): Promise<ExecutionOperation> {
  const client = await input.database.connect();
  let operation: ExecutionOperation | null = null;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [`execution:${input.userId}`]);
    const existing = await findByIdempotency(client, input.userId, input.idempotencyKey);
    if (existing) {
      if (existing.confirmationId !== input.confirmationId) {
        throw new AppError(409, "idempotency_key_reused", "This idempotency key is already bound to another confirmation.");
      }
      return existing;
    }
    const context = await loadConfirmation(client, input.userId, input.confirmationId);
    assertConfirmationActive(context);
    const proposal = proposalSchema.parse(context.proposal);
    const originalVerdict = verdictSchema.parse(context.original_verdict);
    const mandate = mandateSchema.parse(context.mandate);
    const portfolioState = portfolioStateSchema.parse(await input.portfolioProvider.getPortfolioState({
      userId: input.userId,
      mandate,
      ...(input.signal ? { signal: input.signal } : {})
    }));
    const verdict = evaluateProposal(mandate, portfolioState, proposal, {
      mandateVersion: context.mandate_version,
      stateMaxAgeSeconds: input.stateMaxAgeSeconds
    });
    const gate = checkExecutionGate(proposal, verdict, { actionKind: "trade", sourceRole: "sentinel" });
    if (!gate.allowed) throw new AppError(409, "execution_blocked", gate.reason, { ruleIds: gate.ruleIds });
    if (originalVerdict.proposalId !== verdict.proposalId) {
      throw new AppError(409, "evaluation_changed", "The execution no longer matches the reviewed proposal.");
    }
    if (mandate.maxSlippageBps === undefined) {
      throw new AppError(409, "slippage_limit_required", "Replace the mandate with an explicit maximum slippage before execution.");
    }

    operation = await createOperation({
      client,
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      context,
      proposal,
      verdict,
      portfolioState
    });
    await client.query(
      `UPDATE execution_operations
          SET status = 'submitting', submitted_at = now(), attempt_count = attempt_count + 1, updated_at = now()
        WHERE id = $1`,
      [operation.id]
    );
    try {
      const receipt = await input.executionProvider.submitTrade({
        clientOrderId: operation.id,
        proposal,
        maximumQuoteNotional: proposal.notionalUsd,
        maximumSlippageBps: mandate.maxSlippageBps,
        confirmedTermsHash: context.terms_hash
      }, input.signal);
      return await updateOperationFromReceipt(client, input.userId, operation.id, proposal, receipt);
    } catch (error) {
      return await markProviderError(client, input.userId, operation.id, error);
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`execution:${input.userId}`]);
    } finally {
      client.release();
    }
  }
}

export async function getExecutionOperation(database: Database, userId: string, operationId: string): Promise<ExecutionOperation> {
  const result = await database.query<OperationRow>(
    `SELECT ${operationColumns} FROM execution_operations WHERE id = $1 AND user_id = $2`,
    [operationId, userId]
  );
  const row = result.rows[0];
  if (!row) throw new AppError(404, "execution_not_found", "The execution operation does not exist.");
  return toOperation(row);
}

export async function reconcileExecution(input: {
  database: Database;
  executionProvider: TradeExecutionProvider;
  userId: string;
  operationId: string;
  signal?: AbortSignal;
}): Promise<ExecutionOperation> {
  const client = await input.database.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [`execution:${input.userId}`]);
    const operation = await getExecutionOperation(input.database, input.userId, input.operationId);
    if (["confirmed", "rejected", "failed"].includes(operation.status)) return operation;
    const request = operation.requestDocument as { proposal?: unknown };
    const proposal = proposalSchema.parse(request.proposal);
    try {
      const receipt = await input.executionProvider.getTradeStatus({
        clientOrderId: operation.id,
        providerOperationId: operation.providerOperationId,
        proposal
      }, input.signal);
      return await updateOperationFromReceipt(client, input.userId, operation.id, proposal, receipt);
    } catch (error) {
      return await markProviderError(client, input.userId, operation.id, error);
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`execution:${input.userId}`]);
    } finally {
      client.release();
    }
  }
}

export async function listTrackedPositions(database: Database, userId: string): Promise<unknown[]> {
  const result = await database.query<{
    id: string; mandate_id: string; mandate_version: number; source_operation_id: string;
    base_asset: string; quote_asset: string; venue: string; opened_base_quantity: string;
    opened_quote_quantity: string; status: string; opened_at: Date; closed_at: Date | null;
    monitor_status: string | null; last_run_at: Date | null; last_error_code: string | null;
  }>(
    `SELECT tracked_positions.id, tracked_positions.mandate_id, tracked_positions.mandate_version,
            tracked_positions.source_operation_id, tracked_positions.base_asset, tracked_positions.quote_asset,
            tracked_positions.venue, tracked_positions.opened_base_quantity::text,
            tracked_positions.opened_quote_quantity::text, tracked_positions.status,
            tracked_positions.opened_at, tracked_positions.closed_at,
            monitor_jobs.status AS monitor_status, monitor_jobs.last_run_at,
            monitor_jobs.last_error_code
       FROM tracked_positions
       LEFT JOIN monitor_jobs ON monitor_jobs.position_id = tracked_positions.id
      WHERE tracked_positions.user_id = $1 ORDER BY tracked_positions.created_at DESC`,
    [userId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    mandateId: row.mandate_id,
    mandateVersion: row.mandate_version,
    sourceOperationId: row.source_operation_id,
    baseAsset: row.base_asset,
    quoteAsset: row.quote_asset,
    venue: row.venue,
    openedBaseQuantity: new Decimal(row.opened_base_quantity).toFixed(),
    openedQuoteQuantity: new Decimal(row.opened_quote_quantity).toFixed(),
    status: row.status,
    monitorStatus: row.monitor_status,
    lastCheckedAt: row.last_run_at?.toISOString() ?? null,
    monitorErrorCode: row.last_error_code,
    openedAt: row.opened_at.toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null
  }));
}
