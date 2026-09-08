import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "./pool.js";

export async function runMigrations(database: Database, migrationsDirectory: string): Promise<string[]> {
  const client = await database.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('scout-sentinel-migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const appliedFiles: string[] = [];
    const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")).sort();
    for (const filename of files) {
      const sql = await readFile(resolve(migrationsDirectory, filename), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const applied = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE filename = $1",
        [filename]
      );
      if (applied.rowCount === 1) {
        if (applied.rows[0]?.checksum !== checksum) throw new Error(`Applied migration changed: ${filename}`);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(filename, checksum) VALUES ($1, $2)", [filename, checksum]);
        await client.query("COMMIT");
        appliedFiles.push(filename);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return appliedFiles;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext('scout-sentinel-migrations'))");
    } finally {
      client.release();
    }
  }
}
