import { mysqlSchemaStatements } from "../adapters/mysql-schema";
import { postgresSchemaPlan, type TablePlan } from "../adapters/postgres-schema";
import {
  DEFAULT_PREFIX,
  DEFAULT_SCHEMA,
  validatePrefix,
  validateSchema,
} from "../adapters/sql-shared";
import { CancelledError, checkDatabase, UsageError, type Flags } from "./args";
import { requireFromProject } from "./detect";
import { out, print } from "./output";
import type { Prompter } from "./prompt";
import { DRIVERS, type Database } from "./templates";

const TABLES = ["roles", "permissions", "role_permissions", "user_roles", "user_permissions"];

/**
 * The password (raw and decoded) from a database URL, so error output can be scrubbed of it
 * even when it appears inside a driver's error message.
 */
export function urlSecrets(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const { password } = new URL(raw);
    return [...new Set([password, safeDecode(password)])].filter((secret) => secret.length > 0);
  } catch {
    return [];
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** What migrate needs from a database connection. */
interface Session {
  /** Which of these (unquoted) table names already exist. */
  existingTables(names: string[]): Promise<Set<string>>;
  run(sql: string): Promise<void>;
  close(): Promise<void>;
}

export async function migrate(flags: Flags, prompter: Prompter | undefined): Promise<void> {
  const rawUrl = flags.url ?? process.env.DATABASE_URL;
  if (!rawUrl) {
    throw new UsageError(
      "No database URL. Set DATABASE_URL or pass --url, e.g. " +
        `${DRIVERS.mysql.urlExample} or ${DRIVERS.postgres.urlExample}`,
    );
  }
  const target = parseUrl(rawUrl);
  if (flags.db !== undefined && checkDatabase(flags.db) !== target.db) {
    throw new UsageError(`--db ${flags.db} doesn't match the URL, which is for ${target.db}.`);
  }
  if (target.db !== "postgres" && flags.schema !== undefined) {
    throw new UsageError("--schema is only used with Postgres URLs.");
  }
  const prefix = toUsage(() => validatePrefix(flags.prefix ?? DEFAULT_PREFIX));
  const schema = toUsage(() => validateSchema(flags.schema ?? DEFAULT_SCHEMA));
  const plan: TablePlan[] =
    target.db === "postgres"
      ? postgresSchemaPlan(prefix, schema)
      : mysqlSchemaStatements(prefix).map((statement, i) => ({
          table: prefix + TABLES[i],
          statements: [statement],
        }));

  print(out.bold("permly migrate"));
  print();
  print(`  Database  ${target.display}`);
  if (target.db === "postgres") print(`  Schema    ${schema}`);
  print(`  Tables    ${plan.map((entry) => entry.table).join(", ")}`);
  print(out.dim("  Creates missing tables only. Existing tables are never changed or dropped."));
  print();

  if (!flags.yes) {
    if (!prompter) {
      throw new UsageError("Pass --yes to confirm when running without a terminal (e.g. in CI).");
    }
    if (!(await prompter.confirm("Create the tables?", false))) throw new CancelledError();
  }

  const session =
    target.db === "postgres"
      ? await openPostgres(rawUrl, target.display, schema)
      : await openMysql(rawUrl, target.display);

  try {
    const existing = await session.existingTables(plan.map((entry) => entry.table));
    for (const { table, statements } of plan) {
      for (const statement of statements) await session.run(statement);
      print(
        existing.has(table)
          ? `  ${out.dim("exists")}   ${table} ${out.dim("(left unchanged)")}`
          : `  ${out.green("created")}  ${table}`,
      );
    }
  } finally {
    await session.close().catch(() => {});
  }

  print();
  print(
    `${out.green("Done.")} Next: call ${out.cyan("perms.sync()")} at startup to create your roles and permissions.`,
  );
}

// --- drivers: always the ones installed in the user's project ---

function loadDriver<T>(db: Database, module: string): T {
  try {
    return requireFromProject(process.cwd())(module) as T;
  } catch {
    const { driver } = DRIVERS[db];
    throw new Error(
      `${driver} is not installed in this project. Install it with: npm install ${driver}`,
    );
  }
}

function connectError(display: string, error: unknown): Error {
  // Only the message is printed (after scrubbing the password), never the cause.
  return new Error(
    `Could not connect to ${display}: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

async function openMysql(url: string, display: string): Promise<Session> {
  interface Connection {
    query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
    end(): Promise<void>;
  }
  const mysql = loadDriver<{
    createConnection(options: { uri: string; connectTimeout: number }): Promise<Connection>;
  }>("mysql", "mysql2/promise");

  let connection: Connection;
  try {
    connection = await mysql.createConnection({ uri: url, connectTimeout: 10_000 });
  } catch (error) {
    throw connectError(display, error);
  }
  return {
    async existingTables(names) {
      const [rows] = await connection.query(
        `SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name IN (${names.map(() => "?").join(", ")})`,
        names,
      );
      return new Set((rows as { name: string }[]).map((row) => row.name));
    },
    async run(sql) {
      await connection.query(sql);
    },
    close: () => connection.end(),
  };
}

async function openPostgres(url: string, display: string, schema: string): Promise<Session> {
  interface Client {
    connect(): Promise<void>;
    query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    end(): Promise<void>;
  }
  const pg = loadDriver<{
    Client: new (config: { connectionString: string; connectionTimeoutMillis: number }) => Client;
  }>("postgres", "pg");

  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => {});
    throw connectError(display, error);
  }

  const { rows } = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema]);
  if (rows.length === 0) {
    await client.end().catch(() => {});
    throw new Error(
      `Schema "${schema}" does not exist in ${display}. Create it first: CREATE SCHEMA "${schema}";`,
    );
  }

  return {
    async existingTables(names) {
      const result = await client.query(
        `SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = ANY($2::text[])`,
        [schema, names],
      );
      return new Set(result.rows.map((row) => String(row.name)));
    },
    async run(sql) {
      await client.query(sql);
    },
    close: () => client.end(),
  };
}

// --- URL ---

interface Target {
  db: Database;
  /** e.g. postgres://user@host:5432/database, without the password. */
  display: string;
}

const SCHEMES: Record<string, { db: Database; port: string }> = {
  mysql: { db: "mysql", port: "3306" },
  mariadb: { db: "mysql", port: "3306" },
  postgres: { db: "postgres", port: "5432" },
  postgresql: { db: "postgres", port: "5432" },
};

function parseUrl(raw: string): Target {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Deliberately not echoing the value: it may contain a password.
    throw new UsageError(
      `The database URL is not valid. Expected e.g. ${DRIVERS.mysql.urlExample} or ${DRIVERS.postgres.urlExample}`,
    );
  }
  const protocol = url.protocol.replace(/:$/, "");
  const scheme = SCHEMES[protocol];
  if (!scheme) {
    throw new UsageError(
      `Unsupported URL scheme "${protocol}:". Use mysql://, mariadb://, postgres:// or postgresql://.`,
    );
  }
  const database = safeDecode(url.pathname.replace(/^\//, ""));
  if (!database) {
    throw new UsageError(
      `The database URL has no database name, e.g. ${DRIVERS[scheme.db].urlExample}`,
    );
  }
  const user = safeDecode(url.username);
  const display = `${protocol}://${user ? `${user}@` : ""}${url.hostname}:${url.port || scheme.port}/${database}`;
  return { db: scheme.db, display };
}

function toUsage<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}
