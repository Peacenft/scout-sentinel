import { createDatabase } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import { loadConfig } from "../src/config.js";
import { resolve } from "node:path";

const config = loadConfig();
if (!config.databaseUrl) throw new Error("DATABASE_URL is required.");
const database = createDatabase(config.databaseUrl);
const migrationsDirectory = resolve(process.cwd(), "migrations");

try {
  const appliedFiles = await runMigrations(database, migrationsDirectory);
  for (const filename of appliedFiles) process.stdout.write(`Applied ${filename}\n`);
} finally {
  await database.end();
}
