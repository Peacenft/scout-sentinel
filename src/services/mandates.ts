import type { Database } from "../db/pool.js";
import { inTransaction } from "../db/transaction.js";
import type { MandateInput } from "../domain/schemas.js";
import { AppError } from "../errors.js";
import { canonicalJson, documentHash } from "../security/crypto.js";
import { appendAuditEvent } from "./audit.js";

export type StoredMandate = {
  id: string;
  version: number;
  document: MandateInput;
  documentHash: string;
  active: boolean;
  createdAt: string;
};

type MandateRow = {
  id: string;
  version: number;
  document: MandateInput;
  document_hash: string;
  active: boolean;
  created_at: Date;
};

function mapMandate(row: MandateRow): StoredMandate {
  return {
    id: row.id,
    version: row.version,
    document: row.document,
    documentHash: row.document_hash,
    active: row.active,
    createdAt: row.created_at.toISOString()
  };
}

export async function createMandate(database: Database, userId: string, document: MandateInput): Promise<StoredMandate> {
  return inTransaction(database, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`mandate:${userId}`]);
    const current = await client.query<{ version: number }>(
      "SELECT version FROM mandates WHERE user_id = $1 AND active = true FOR UPDATE",
      [userId]
    );
    const nextVersion = (current.rows[0]?.version ?? 0) + 1;
    await client.query("UPDATE mandates SET active = false WHERE user_id = $1 AND active = true", [userId]);
    const hash = documentHash(document);
    const inserted = await client.query<MandateRow>(
      `INSERT INTO mandates(user_id, version, name, document, document_hash)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id, version, document, document_hash, active, created_at`,
      [userId, nextVersion, document.name, canonicalJson(document), hash]
    );
    const row = inserted.rows[0];
    if (!row) throw new AppError(500, "mandate_create_failed", "The mandate could not be saved.");
    await appendAuditEvent(client, {
      userId,
      eventType: "mandate.activated",
      aggregateType: "mandate",
      aggregateId: row.id,
      payload: { version: row.version, documentHash: row.document_hash }
    });
    return mapMandate(row);
  });
}

export async function getActiveMandate(database: Database, userId: string): Promise<StoredMandate> {
  const result = await database.query<MandateRow>(
    `SELECT id, version, document, document_hash, active, created_at
       FROM mandates WHERE user_id = $1 AND active = true`,
    [userId]
  );
  const row = result.rows[0];
  if (!row) throw new AppError(404, "mandate_not_found", "No active mandate exists.");
  return mapMandate(row);
}
