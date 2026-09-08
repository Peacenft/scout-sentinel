import pg from "pg";

const { Pool } = pg;

export type Database = pg.Pool;

export function createDatabase(connectionString: string): Database {
  return new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: "scout-sentinel"
  });
}

export function createLazyDatabase(getConnectionString: () => string): Database {
  let database: Database | undefined;
  const getDatabase = (): Database => {
    database ??= createDatabase(getConnectionString());
    return database;
  };
  return new Proxy({} as Database, {
    get(_target, property) {
      const activeDatabase = getDatabase();
      const value = Reflect.get(activeDatabase, property);
      return typeof value === "function" ? value.bind(activeDatabase) : value;
    }
  });
}
