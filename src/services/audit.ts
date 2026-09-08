import type pg from "pg";
import { randomUUID } from "node:crypto";
import { canonicalJson, documentHash } from "../security/crypto.js";
import type { Database } from "../db/pool.js";

export type AuditEventInput = {
  userId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
};

export async function appendAuditEvent(database: pg.PoolClient, input: AuditEventInput): Promise<void> {
  await database.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`audit:${input.userId}`]);
  const previous = await database.query<{ event_hash: string }>(
    "SELECT event_hash FROM audit_events WHERE user_id = $1 ORDER BY sequence DESC LIMIT 1",
    [input.userId]
  );
  const previousHash = previous.rows[0]?.event_hash ?? null;
  const id = randomUUID();
  const createdAt = new Date();
  const hashVersion = 2;
  const eventHash = documentHash({
    id,
    userId: input.userId,
    eventType: input.eventType,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    payload: JSON.parse(canonicalJson(input.payload)),
    previousHash,
    createdAt: createdAt.toISOString(),
    hashVersion
  });
  await database.query(
    `INSERT INTO audit_events(
       id, user_id, event_type, aggregate_type, aggregate_id, payload, previous_hash, event_hash, created_at, hash_version
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)`,
    [
      id,
      input.userId,
      input.eventType,
      input.aggregateType,
      input.aggregateId,
      canonicalJson(input.payload),
      previousHash,
      eventHash,
      createdAt,
      hashVersion
    ]
  );
}

export type AuditEvent = {
  sequence: string;
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  previousHash: string | null;
  eventHash: string;
  createdAt: string;
  hashVersion: number;
};

type AuditRow = {
  sequence: string;
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  previous_hash: string | null;
  event_hash: string;
  created_at: Date;
  hash_version: number;
};

export async function listAuditEvents(
  database: Database,
  userId: string,
  limit: number,
  beforeSequence?: string
): Promise<AuditEvent[]> {
  const result = await database.query<AuditRow>(
    `SELECT sequence::text, id, event_type, aggregate_type, aggregate_id, payload, previous_hash, event_hash, created_at, hash_version
       FROM audit_events
      WHERE user_id = $1
        AND ($2::bigint IS NULL OR sequence < $2::bigint)
      ORDER BY audit_events.sequence DESC
      LIMIT $3`,
    [userId, beforeSequence ?? null, limit]
  );
  return result.rows.map((row) => ({
    sequence: row.sequence,
    id: row.id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
    createdAt: row.created_at.toISOString(),
    hashVersion: row.hash_version
  }));
}

export async function verifyAuditChain(database: Database, userId: string): Promise<{ valid: boolean; eventCount: number; brokenAt: string | null }> {
  const result = await database.query<AuditRow>(
    `SELECT sequence::text, id, event_type, aggregate_type, aggregate_id, payload, previous_hash, event_hash, created_at, hash_version
       FROM audit_events WHERE user_id = $1 ORDER BY audit_events.sequence`,
    [userId]
  );
  let previousHash: string | null = null;
  for (const row of result.rows) {
    const baseEvent: Record<string, unknown> = {
      userId,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload: JSON.parse(canonicalJson(row.payload)),
      previousHash
    };
    const expected: string = row.hash_version === 2
      ? documentHash({
          id: row.id,
          ...baseEvent,
          createdAt: row.created_at.toISOString(),
          hashVersion: 2
        })
      : documentHash(baseEvent);
    if (row.previous_hash !== previousHash || row.event_hash !== expected) {
      return { valid: false, eventCount: result.rows.length, brokenAt: row.sequence };
    }
    previousHash = row.event_hash;
  }
  return { valid: true, eventCount: result.rows.length, brokenAt: null };
}
