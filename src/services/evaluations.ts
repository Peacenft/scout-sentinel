import type { Database } from "../db/pool.js";
import { inTransaction } from "../db/transaction.js";
import type { PortfolioState, Proposal, Verdict } from "../domain/schemas.js";
import { evaluateProposal } from "../engine/evaluate.js";
import { AppError } from "../errors.js";
import type { PortfolioStateProvider } from "../integrations/portfolio-state-provider.js";
import { canonicalJson, documentHash } from "../security/crypto.js";
import { appendAuditEvent } from "./audit.js";
import { getActiveMandate } from "./mandates.js";

export type EvaluationRecord = {
  id: string;
  proposal: Proposal;
  portfolioState: PortfolioState;
  verdict: Verdict;
};

export async function evaluateWithTrustedState(input: {
  database: Database;
  provider: PortfolioStateProvider;
  userId: string;
  proposal: Proposal;
  stateMaxAgeSeconds: number;
  signal?: AbortSignal;
}): Promise<EvaluationRecord> {
  const mandate = await getActiveMandate(input.database, input.userId);
  const portfolioState = await input.provider.getPortfolioState({
    userId: input.userId,
    mandate: mandate.document,
    ...(input.signal ? { signal: input.signal } : {})
  });
  const verdict = evaluateProposal(mandate.document, portfolioState, input.proposal, {
    mandateVersion: mandate.version,
    stateMaxAgeSeconds: input.stateMaxAgeSeconds
  });

  return inTransaction(input.database, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evaluation:${input.userId}`]);
    const current = await client.query<{ id: string; version: number }>(
      "SELECT id, version FROM mandates WHERE user_id = $1 AND active = true FOR UPDATE",
      [input.userId]
    );
    const currentMandate = current.rows[0];
    if (!currentMandate || currentMandate.id !== mandate.id || currentMandate.version !== mandate.version) {
      throw new AppError(409, "mandate_changed", "The mandate changed while account state was being read. Evaluate again.");
    }

    const insertedProposal = await client.query(
      `INSERT INTO proposals(id, user_id, mandate_id, mandate_version, document, document_hash, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        input.proposal.id,
        input.userId,
        mandate.id,
        mandate.version,
        canonicalJson(input.proposal),
        documentHash(input.proposal),
        input.proposal.createdAt
      ]
    );
    if (insertedProposal.rowCount !== 1) {
      throw new AppError(409, "proposal_already_evaluated", "This proposal ID has already been received.");
    }

    const insertedEvaluation = await client.query<{ id: string }>(
      `INSERT INTO evaluations(
         user_id, mandate_id, mandate_version, proposal_id, portfolio_state, portfolio_state_hash, verdict
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
       RETURNING id`,
      [
        input.userId,
        mandate.id,
        mandate.version,
        input.proposal.id,
        canonicalJson(portfolioState),
        documentHash(portfolioState),
        canonicalJson(verdict)
      ]
    );
    const evaluationId = insertedEvaluation.rows[0]?.id;
    if (!evaluationId) throw new AppError(500, "evaluation_save_failed", "The evaluation could not be saved.");
    await appendAuditEvent(client, {
      userId: input.userId,
      eventType: "proposal.evaluated",
      aggregateType: "evaluation",
      aggregateId: evaluationId,
      payload: {
        proposalId: input.proposal.id,
        mandateId: mandate.id,
        mandateVersion: mandate.version,
        stateHash: documentHash(portfolioState),
        verdict
      }
    });
    return { id: evaluationId, proposal: input.proposal, portfolioState, verdict };
  });
}
