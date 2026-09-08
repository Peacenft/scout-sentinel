import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { resolve } from "node:path";

const config = loadConfig();
if (!config.databaseUrl) throw new Error("DATABASE_URL is required.");
const database = createDatabase(config.databaseUrl);
const migrations = await runMigrations(database, resolve(process.cwd(), "migrations"));
const app = await buildApp(config, database);
if (migrations.length > 0) app.log.info({ migrations }, "database migrations applied");

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await database.end();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
