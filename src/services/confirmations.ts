import type { Database } from "../db/pool.js";
import { inTransaction } from "../db/transaction.js";
import type { Verdict } from "../domain/schemas.js";
import { AppError } from "../errors.js";
import { documentHash } from "../security/crypto.js";
import { appendAuditEvent } from "./audit.js";

const CONFIRMATION_TTL_MS = 90_000;

export type ConfirmationRequest = {
  id: string;
  evaluationId: string;
  termsHash: string;
  expiresAt: string;
  confirmedAt: string | null;
};

export type ConfirmationReview = ConfirmationRequest & {
  proposal: unknown;
  verdict: Verdict;
};

type EvaluationTermsRow = {
  evaluation_id: string;
  verdict: Verdict;
  proposal: unknown;
  portfolio_state_hash: string;
  mandate_hash: string;
};

export async function requestConfirmation(database: Database, userId: string, evaluationId: string): Promise<ConfirmationRequest> {
  return inTransaction(database, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`confirmation:${evaluationId}`]);
    await client.query(
      `UPDATE confirmation_requests
          SET cancelled_at = now()
        WHERE evaluation_id = $1 AND user_id = $2
          AND confirmed_at IS NULL AND consumed_at IS NULL AND cancelled_at IS NULL
          AND expires_at <= now()`,
      [evaluationId, userId]
    );
    const existing = await client.query<{ id: string; terms_hash: string; expires_at: Date }>(
      `SELECT id, terms_hash, expires_at
         FROM confirmation_requests
        WHERE evaluation_id = $1 AND user_id = $2
          AND confirmed_at IS NULL AND consumed_at IS NULL AND cancelled_at IS NULL
        FOR UPDATE`,
      [evaluationId, userId]
    );
    const active = existing.rows[0];
    if (active) {
      return {
        id: active.id,
        evaluationId,
        termsHash: active.terms_hash,
        expiresAt: active.expires_at.toISOString(),
        confirmedAt: null
      };
    }
    const result = await client.query<EvaluationTermsRow>(
      `SELECT evaluations.id AS evaluation_id, evaluations.verdict, proposals.document AS proposal,
              evaluations.portfolio_state_hash, mandates.document_hash AS mandate_hash
         FROM evaluations
         JOIN proposals ON proposals.id = evaluations.proposal_id
         JOIN mandates ON mandates.id = evaluations.mandate_id
        WHERE evaluations.id = $1 AND evaluations.user_id = $2
        FOR UPDATE OF evaluations`,
      [evaluationId, userId]
    );
    const terms = result.rows[0];
    if (!terms) throw new AppError(404, "evaluation_not_found", "The evaluation does not exist.");
    if (!["APPROVED_NEEDS_USER", "PROTECT_EXIT"].includes(terms.verdict.decision)) {
      throw new AppError(409, "confirmation_not_allowed", "The verdict does not permit confirmation.");
    }
    const termsHash = documentHash({
      evaluationId: terms.evaluation_id,
      proposal: terms.proposal,
      verdict: terms.verdict,
      portfolioStateHash: terms.portfolio_state_hash,
      mandateHash: terms.mandate_hash
    });
    const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS);
    const inserted = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO confirmation_requests(user_id, evaluation_id, terms_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, expires_at`,
      [userId, evaluationId, termsHash, expiresAt]
    );
    const record = inserted.rows[0];
    if (!record) throw new AppError(500, "confirmation_create_failed", "The confirmation request could not be created.");
    await appendAuditEvent(client, {
      userId,
      eventType: "confirmation.requested",
      aggregateType: "confirmation",
      aggregateId: record.id,
      payload: { evaluationId, termsHash, expiresAt: record.expires_at.toISOString() }
    });
    return {
      id: record.id,
      evaluationId,
      termsHash,
      expiresAt: record.expires_at.toISOString(),
      confirmedAt: null
    };
  });
}

export async function confirmTerms(
  database: Database,
  userId: string,
  confirmationId: string,
  suppliedTermsHash: string
): Promise<ConfirmationRequest> {
  return inTransaction(database, async (client) => {
    const result = await client.query<{
      id: string;
      evaluation_id: string;
      terms_hash: string;
      expires_at: Date;
      confirmed_at: Date | null;
      consumed_at: Date | null;
      cancelled_at: Date | null;
    }>(
      `SELECT id, evaluation_id, terms_hash, expires_at, confirmed_at, consumed_at, cancelled_at
         FROM confirmation_requests
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [confirmationId, userId]
    );
    const confirmation = result.rows[0];
    if (!confirmation) throw new AppError(404, "confirmation_not_found", "The confirmation request does not exist.");
    if (confirmation.consumed_at || confirmation.cancelled_at) {
      throw new AppError(409, "confirmation_inactive", "The confirmation is no longer active.");
    }
    if (confirmation.confirmed_at) {
      throw new AppError(409, "confirmation_already_used", "The confirmation has already been accepted.");
    }
    if (confirmation.expires_at.getTime() <= Date.now()) {
      throw new AppError(409, "confirmation_expired", "The confirmation expired. Evaluate the proposal again.");
    }
    if (confirmation.terms_hash !== suppliedTermsHash) {
      throw new AppError(409, "confirmation_terms_changed", "The confirmed terms do not match the reviewed evaluation.");
    }
    const updated = await client.query<{ confirmed_at: Date }>(
      "UPDATE confirmation_requests SET confirmed_at = now() WHERE id = $1 RETURNING confirmed_at",
      [confirmationId]
    );
    const confirmedAt = updated.rows[0]?.confirmed_at;
    if (!confirmedAt) throw new AppError(500, "confirmation_update_failed", "The confirmation could not be saved.");
    await appendAuditEvent(client, {
      userId,
      eventType: "confirmation.accepted",
      aggregateType: "confirmation",
      aggregateId: confirmationId,
      payload: { evaluationId: confirmation.evaluation_id, termsHash: confirmation.terms_hash, confirmedAt: confirmedAt.toISOString() }
    });
    return {
      id: confirmation.id,
      evaluationId: confirmation.evaluation_id,
      termsHash: confirmation.terms_hash,
      expiresAt: confirmation.expires_at.toISOString(),
      confirmedAt: confirmedAt.toISOString()
    };
  });
}

export async function getConfirmationReview(database: Database, userId: string, confirmationId: string): Promise<ConfirmationReview> {
  const result = await database.query<{
    id: string;
    evaluation_id: string;
    terms_hash: string;
    expires_at: Date;
    confirmed_at: Date | null;
    proposal: unknown;
    verdict: Verdict;
  }>(
    `SELECT confirmation_requests.id, confirmation_requests.evaluation_id, confirmation_requests.terms_hash,
            confirmation_requests.expires_at, confirmation_requests.confirmed_at,
            proposals.document AS proposal, evaluations.verdict
       FROM confirmation_requests
       JOIN evaluations ON evaluations.id = confirmation_requests.evaluation_id
       JOIN proposals ON proposals.id = evaluations.proposal_id
      WHERE confirmation_requests.id = $1 AND confirmation_requests.user_id = $2
        AND confirmation_requests.consumed_at IS NULL AND confirmation_requests.cancelled_at IS NULL`,
    [confirmationId, userId]
  );
  const row = result.rows[0];
  if (!row) throw new AppError(404, "confirmation_not_found", "The confirmation request does not exist.");
  return {
    id: row.id,
    evaluationId: row.evaluation_id,
    termsHash: row.terms_hash,
    expiresAt: row.expires_at.toISOString(),
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    proposal: row.proposal,
    verdict: row.verdict
  };
}

export async function listPendingConfirmations(database: Database, userId: string): Promise<ConfirmationReview[]> {
  const result = await database.query<{
    id: string;
    evaluation_id: string;
    terms_hash: string;
    expires_at: Date;
    confirmed_at: Date | null;
    proposal: unknown;
    verdict: Verdict;
  }>(
    `SELECT confirmation_requests.id, confirmation_requests.evaluation_id, confirmation_requests.terms_hash,
            confirmation_requests.expires_at, confirmation_requests.confirmed_at,
            proposals.document AS proposal, evaluations.verdict
       FROM confirmation_requests
       JOIN evaluations ON evaluations.id = confirmation_requests.evaluation_id
       JOIN proposals ON proposals.id = evaluations.proposal_id
      WHERE confirmation_requests.user_id = $1 AND confirmation_requests.confirmed_at IS NULL
        AND confirmation_requests.consumed_at IS NULL AND confirmation_requests.cancelled_at IS NULL
        AND confirmation_requests.expires_at > now()
      ORDER BY confirmation_requests.created_at DESC
      LIMIT 20`,
    [userId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    evaluationId: row.evaluation_id,
    termsHash: row.terms_hash,
    expiresAt: row.expires_at.toISOString(),
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    proposal: row.proposal,
    verdict: row.verdict
  }));
}
