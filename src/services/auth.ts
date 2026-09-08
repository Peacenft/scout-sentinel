import { timingSafeEqual } from "node:crypto";
import type { Database } from "../db/pool.js";
import { inTransaction } from "../db/transaction.js";
import { AppError } from "../errors.js";
import { randomToken, tokenHash } from "../security/crypto.js";
import { hashPassword, verifyPassword } from "../security/password.js";
import { appendAuditEvent } from "./audit.js";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DASHBOARD_ACCESS_TTL_MS = 5 * 60 * 1000;

export type AuthenticatedUser = { id: string; email: string | null; identityType: "operator" | "agent" };

type UserRow = { id: string; email: string | null; identity_type: "operator" | "agent" };

function mapUser(row: UserRow): AuthenticatedUser {
  return { id: row.id, email: row.email, identityType: row.identity_type };
}

async function persistSession(
  database: Database,
  pepper: string,
  user: AuthenticatedUser,
  eventType: "session.created" | "session.restored"
): Promise<{ user: AuthenticatedUser; token: string; expiresAt: string }> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await inTransaction(database, async (client) => {
    const inserted = await client.query<{ id: string }>(
      "INSERT INTO sessions(user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id",
      [user.id, tokenHash(token, pepper), expiresAt]
    );
    const sessionId = inserted.rows[0]?.id;
    if (!sessionId) throw new AppError(500, "session_create_failed", "The session could not be created.");
    await appendAuditEvent(client, {
      userId: user.id,
      eventType,
      aggregateType: "session",
      aggregateId: sessionId,
      payload: { expiresAt: expiresAt.toISOString() }
    });
  });
  return { user, token, expiresAt: expiresAt.toISOString() };
}

function equalSecret(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function bootstrapAdmin(
  database: Database,
  configuredToken: string,
  suppliedToken: string,
  email: string,
  password: string
): Promise<AuthenticatedUser> {
  if (!equalSecret(configuredToken, suppliedToken)) {
    throw new AppError(403, "bootstrap_forbidden", "The bootstrap token is invalid.");
  }
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);
  return inTransaction(database, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('bootstrap-admin'))");
    const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM users WHERE identity_type = 'operator'");
    if (count.rows[0]?.count !== "0") {
      throw new AppError(409, "bootstrap_closed", "An operator account already exists.");
    }
    const created = await client.query<UserRow>(
      "INSERT INTO users(email, password_hash, identity_type) VALUES ($1, $2, 'operator') RETURNING id, email, identity_type",
      [normalizedEmail, passwordHash]
    );
    const row = created.rows[0];
    if (!row) throw new AppError(500, "user_create_failed", "The operator account could not be created.");
    const user = mapUser(row);
    await appendAuditEvent(client, {
      userId: user.id,
      eventType: "operator.created",
      aggregateType: "user",
      aggregateId: user.id,
      payload: { email: user.email }
    });
    return user;
  });
}

export async function createSession(
  database: Database,
  pepper: string,
  email: string,
  password: string
): Promise<{ user: AuthenticatedUser; token: string; expiresAt: string }> {
  const result = await database.query<UserRow & { password_hash: string | null; disabled_at: Date | null }>(
    "SELECT id, email, identity_type, password_hash, disabled_at FROM users WHERE email = $1 AND identity_type = 'operator'",
    [email.trim().toLowerCase()]
  );
  const record = result.rows[0];
  if (!record || !record.password_hash || record.disabled_at || !(await verifyPassword(record.password_hash, password))) {
    throw new AppError(401, "invalid_credentials", "Email or password is incorrect.");
  }
  return persistSession(database, pepper, mapUser(record), "session.created");
}

export async function createAgentWorkspaceSession(
  database: Database,
  pepper: string
): Promise<{ user: AuthenticatedUser; token: string; expiresAt: string }> {
  const row = await inTransaction(database, async (client) => {
    const created = await client.query<UserRow>(
      "INSERT INTO users(email, password_hash, identity_type) VALUES (NULL, NULL, 'agent') RETURNING id, email, identity_type"
    );
    const user = created.rows[0];
    if (!user) throw new AppError(500, "workspace_create_failed", "The private workspace could not be created.");
    await appendAuditEvent(client, {
      userId: user.id,
      eventType: "workspace.created",
      aggregateType: "user",
      aggregateId: user.id,
      payload: { identityType: "agent" }
    });
    return user;
  });
  return persistSession(database, pepper, mapUser(row), "session.created");
}

export async function createDashboardAccessToken(
  database: Database,
  pepper: string,
  userId: string
): Promise<{ token: string; expiresAt: string }> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + DASHBOARD_ACCESS_TTL_MS);
  await database.query("DELETE FROM dashboard_access_tokens WHERE expires_at < now() - interval '1 day'");
  await database.query(
    "INSERT INTO dashboard_access_tokens(user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    [userId, tokenHash(token, pepper), expiresAt]
  );
  return { token, expiresAt: expiresAt.toISOString() };
}

export async function restoreDashboardSession(
  database: Database,
  pepper: string,
  token: string
): Promise<{ user: AuthenticatedUser; token: string; expiresAt: string }> {
  const user = await inTransaction(database, async (client) => {
    const result = await client.query<UserRow & { token_id: string }>(
      `SELECT users.id, users.email, users.identity_type, dashboard_access_tokens.id AS token_id
         FROM dashboard_access_tokens
         JOIN users ON users.id = dashboard_access_tokens.user_id
        WHERE dashboard_access_tokens.token_hash = $1
          AND dashboard_access_tokens.used_at IS NULL
          AND dashboard_access_tokens.expires_at > now()
          AND users.disabled_at IS NULL
        FOR UPDATE OF dashboard_access_tokens`,
      [tokenHash(token, pepper)]
    );
    const row = result.rows[0];
    if (!row) throw new AppError(401, "dashboard_access_invalid", "The dashboard access link is invalid or expired.");
    await client.query("UPDATE dashboard_access_tokens SET used_at = now() WHERE id = $1", [row.token_id]);
    return mapUser(row);
  });
  return persistSession(database, pepper, user, "session.restored");
}

export async function authenticateSession(database: Database, pepper: string, token: string): Promise<AuthenticatedUser> {
  const result = await database.query<UserRow>(
    `SELECT users.id, users.email, users.identity_type
       FROM sessions
       JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = $1
        AND sessions.revoked_at IS NULL
        AND sessions.expires_at > now()
        AND users.disabled_at IS NULL`,
    [tokenHash(token, pepper)]
  );
  const user = result.rows[0];
  if (!user) throw new AppError(401, "unauthorized", "A valid session is required.");
  return mapUser(user);
}

export async function revokeSession(database: Database, pepper: string, token: string): Promise<void> {
  await inTransaction(database, async (client) => {
    const revoked = await client.query<{ id: string; user_id: string; revoked_at: Date }>(
      `UPDATE sessions SET revoked_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL
        RETURNING id, user_id, revoked_at`,
      [tokenHash(token, pepper)]
    );
    const session = revoked.rows[0];
    if (!session) return;
    await appendAuditEvent(client, {
      userId: session.user_id,
      eventType: "session.revoked",
      aggregateType: "session",
      aggregateId: session.id,
      payload: { revokedAt: session.revoked_at.toISOString() }
    });
  });
}
