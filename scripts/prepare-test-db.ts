import { resolve } from "node:path";
import { createDatabase } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";

const rawUrl = process.env.TEST_DATABASE_URL;
if (!rawUrl) throw new Error("TEST_DATABASE_URL is required.");

const targetUrl = new URL(rawUrl);
const databaseName = decodeURIComponent(targetUrl.pathname.slice(1));
if (!/^[A-Za-z0-9_]+_test$/.test(databaseName)) {
  throw new Error("TEST_DATABASE_URL must use a simple database name ending in _test.");
}

const maintenanceUrl = new URL(targetUrl);
maintenanceUrl.pathname = "/postgres";
const maintenanceDatabase = createDatabase(maintenanceUrl.toString());

try {
  const existing = await maintenanceDatabase.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
  if (existing.rowCount === 0) {
    await maintenanceDatabase.query(`CREATE DATABASE "${databaseName}"`);
    process.stdout.write(`Created ${databaseName}\n`);
  }
} finally {
  await maintenanceDatabase.end();
}

const testDatabase = createDatabase(targetUrl.toString());
try {
  const appliedFiles = await runMigrations(testDatabase, resolve(process.cwd(), "migrations"));
  for (const filename of appliedFiles) process.stdout.write(`Applied ${filename} to ${databaseName}\n`);
} finally {
  await testDatabase.end();
}
