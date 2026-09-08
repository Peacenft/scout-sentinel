import { Decimal } from "decimal.js";
import type { Database } from "../db/pool.js";
import { inTransaction } from "../db/transaction.js";
import { mandateSchema, portfolioStateSchema, type MandateInput } from "../domain/schemas.js";
import type { PortfolioStateProvider } from "../integrations/portfolio-state-provider.js";
import { canonicalJson, documentHash } from "../security/crypto.js";
import { appendAuditEvent } from "./audit.js";

type ClaimedJob = {
  id: string;
  user_id: string;
  position_id: string;
  consecutive_failures: number;
  base_asset: string;
  mandate: unknown;
};

export type MonitorBatchResult = {
  claimed: number;
  checked: number;
  eventsCreated: number;
  failed: number;
};

async function claimJobs(database: Database, workerId: string, limit: number): Promise<ClaimedJob[]> {
  return inTransaction(database, async (client) => {
    const result = await client.query<ClaimedJob>(
      `WITH due AS (
         SELECT monitor_jobs.id
           FROM monitor_jobs
          WHERE monitor_jobs.status = 'active'
            AND monitor_jobs.next_run_at <= now()
            AND (monitor_jobs.lease_expires_at IS NULL OR monitor_jobs.lease_expires_at <= now())
          ORDER BY monitor_jobs.next_run_at
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE monitor_jobs
          SET lease_owner = $1, lease_expires_at = now() + interval '45 seconds', updated_at = now()
        WHERE monitor_jobs.id IN (SELECT id FROM due)
       RETURNING monitor_jobs.id, monitor_jobs.user_id, monitor_jobs.position_id,
         monitor_jobs.consecutive_failures,
         (SELECT base_asset FROM tracked_positions WHERE tracked_positions.id = monitor_jobs.position_id) AS base_asset,
         (SELECT mandates.document FROM tracked_positions
            JOIN mandates ON mandates.id = tracked_positions.mandate_id AND mandates.version = tracked_positions.mandate_version
           WHERE tracked_positions.id = monitor_jobs.position_id) AS mandate`,
      [workerId, limit]
    );
    return result.rows;
  });
}

async function recordSuccess(input: {
  database: Database;
  provider: PortfolioStateProvider;
  workerId: string;
  job: ClaimedJob;
  mandate: MandateInput;
  intervalSeconds: number;
  stateMaxAgeSeconds: number;
}): Promise<boolean> {
  const state = portfolioStateSchema.parse(await input.provider.getPortfolioState({
    userId: input.job.user_id,
    mandate: input.mandate
  }));
  const ageMs = Date.now() - new Date(state.asOf).getTime();
  if (ageMs < 0 || ageMs > input.stateMaxAgeSeconds * 1000) {
    throw new Error("portfolio_state_stale");
  }
  const holding = new Decimal(state.holdingsUsd[input.job.base_asset] ?? "0");
  const loss = Decimal.max(0, new Decimal(state.realizedPnlUsd).plus(state.unrealizedPnlUsd).negated());
  const threshold = new Decimal(input.mandate.capitalUsd).mul(input.mandate.exitIfLossPct).div(100);
  const eventType = holding.lte(0) ? "position_missing" : loss.gte(threshold) ? "drawdown_threshold" : null;

  return inTransaction(input.database, async (client) => {
    let eventCreated = false;
    if (eventType) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO protection_events(
           user_id, position_id, monitor_job_id, event_type, portfolio_state_hash, details
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (position_id, event_type) WHERE status = 'action_required' DO NOTHING
         RETURNING id`,
        [
          input.job.user_id,
          input.job.position_id,
          input.job.id,
          eventType,
          documentHash(state),
          canonicalJson({
            stateAsOf: state.asOf,
            baseAsset: input.job.base_asset,
            holdingUsd: holding.toFixed(),
            lossUsd: loss.toFixed(),
            thresholdUsd: threshold.toFixed()
          })
        ]
      );
      const eventId = inserted.rows[0]?.id;
      if (eventId) {
        eventCreated = true;
        await appendAuditEvent(client, {
          userId: input.job.user_id,
          eventType: `protection.${eventType}`,
          aggregateType: "protection_event",
          aggregateId: eventId,
          payload: { positionId: input.job.position_id, stateAsOf: state.asOf, stateHash: documentHash(state) }
        });
      }
    }

    if (eventType === "position_missing") {
      await client.query("UPDATE tracked_positions SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1", [input.job.position_id]);
      await client.query(
        `UPDATE monitor_jobs
            SET status = 'completed', last_run_at = now(), consecutive_failures = 0,
                lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL, updated_at = now()
          WHERE id = $1 AND lease_owner = $2`,
        [input.job.id, input.workerId]
      );
    } else {
      await client.query(
        `UPDATE monitor_jobs
            SET next_run_at = now() + ($3::text || ' seconds')::interval,
                last_run_at = now(), consecutive_failures = 0, lease_owner = NULL,
                lease_expires_at = NULL, last_error_code = NULL, updated_at = now()
          WHERE id = $1 AND lease_owner = $2`,
        [input.job.id, input.workerId, input.intervalSeconds]
      );
    }
    return eventCreated;
  });
}

async function recordFailure(database: Database, workerId: string, job: ClaimedJob, maxFailures: number, error: unknown): Promise<void> {
  const failures = job.consecutive_failures + 1;
  const backoffSeconds = Math.min(900, 15 * 2 ** Math.min(failures - 1, 6));
  const code = error instanceof Error && error.message === "portfolio_state_stale" ? "portfolio_state_stale" : "portfolio_read_failed";
  await database.query(
    `UPDATE monitor_jobs
        SET status = CASE WHEN $3 >= $4 THEN 'failed' ELSE 'active' END,
            consecutive_failures = $3, next_run_at = now() + ($5::text || ' seconds')::interval,
            lease_owner = NULL, lease_expires_at = NULL, last_error_code = $6, updated_at = now()
      WHERE id = $1 AND lease_owner = $2`,
    [job.id, workerId, failures, maxFailures, backoffSeconds, code]
  );
}

export async function runMonitorBatch(input: {
  database: Database;
  provider: PortfolioStateProvider;
  workerId: string;
  intervalSeconds: number;
  stateMaxAgeSeconds: number;
  limit?: number;
  maxFailures?: number;
}): Promise<MonitorBatchResult> {
  const jobs = await claimJobs(input.database, input.workerId, input.limit ?? 20);
  const result: MonitorBatchResult = { claimed: jobs.length, checked: 0, eventsCreated: 0, failed: 0 };
  for (const job of jobs) {
    try {
      const mandate = mandateSchema.parse(job.mandate);
      const created = await recordSuccess({
        database: input.database,
        provider: input.provider,
        workerId: input.workerId,
        job,
        mandate,
        intervalSeconds: input.intervalSeconds,
        stateMaxAgeSeconds: input.stateMaxAgeSeconds
      });
      result.checked += 1;
      if (created) result.eventsCreated += 1;
    } catch (error) {
      result.failed += 1;
      await recordFailure(input.database, input.workerId, job, input.maxFailures ?? 5, error);
    }
  }
  return result;
}

export function startMonitorWorker(input: {
  database: Database;
  provider: PortfolioStateProvider;
  intervalSeconds: number;
  stateMaxAgeSeconds: number;
  logger: { info(value: unknown, message: string): void; error(value: unknown, message: string): void };
}): () => void {
  const workerId = `monitor-${process.pid}-${crypto.randomUUID()}`;
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await runMonitorBatch({
        database: input.database,
        provider: input.provider,
        workerId,
        intervalSeconds: input.intervalSeconds,
        stateMaxAgeSeconds: input.stateMaxAgeSeconds
      });
      if (result.claimed > 0) input.logger.info({ result }, "monitor batch completed");
    } catch (error) {
      input.logger.error({ errorName: error instanceof Error ? error.name : "unknown" }, "monitor batch failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), Math.max(5_000, input.intervalSeconds * 1_000));
  timer.unref();
  void run();
  return () => clearInterval(timer);
}

export async function listProtectionEvents(database: Database, userId: string): Promise<unknown[]> {
  const result = await database.query<{
    id: string; position_id: string; event_type: string; status: string; details: unknown; detected_at: Date;
  }>(
    `SELECT id, position_id, event_type, status, details, detected_at
       FROM protection_events WHERE user_id = $1 ORDER BY detected_at DESC LIMIT 100`,
    [userId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    positionId: row.position_id,
    eventType: row.event_type,
    status: row.status,
    details: row.details,
    detectedAt: row.detected_at.toISOString()
  }));
}
