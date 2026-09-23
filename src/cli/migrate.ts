import { mysqlSchemaStatements } from "../adapters/mysql-schema";
import { DEFAULT_PREFIX, validatePrefix } from "../adapters/sql-shared";
import { CancelledError, checkDatabase, UsageError, type Flags } from "./args";
import { requireFromProject } from "./detect";
import { out, print } from "./output";
import type { Prompter } from "./prompt";

const TABLES = ["roles", "permissions", "role_permissions", "user_roles", "user_permissions"];

interface MySqlConnection {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}
interface MySqlDriver {
  createConnection(options: { uri: string; connectTimeout?: number }): Promise<MySqlConnection>;
}

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

export async function migrate(flags: Flags, prompter: Prompter | undefined): Promise<void> {
  const rawUrl = flags.url ?? process.env.DATABASE_URL;
  if (!rawUrl) {
    throw new UsageError(
      "No database URL. Set DATABASE_URL or pass --url mysql://user:password@host:3306/database",
    );
  }
  const target = parseUrl(rawUrl);
  if (flags.db !== undefined && checkDatabase(flags.db) !== target.db) {
    throw new UsageError(`--db ${flags.db} doesn't match the URL, which is for ${target.db}.`);
  }
  const prefix = checkPrefix(flags.prefix);

  print(out.bold("permly migrate"));
  print();
  print(`  Database  ${target.display}`);
  print(`  Tables    ${TABLES.map((table) => prefix + table).join(", ")}`);
  print(out.dim("  Creates missing tables only. Existing tables are never changed or dropped."));
  print();

  if (!flags.yes) {
    if (!prompter) {
      throw new UsageError("Pass --yes to confirm when running without a terminal (e.g. in CI).");
    }
    if (!(await prompter.confirm("Create the tables?", false))) throw new CancelledError();
  }

  const driver = loadDriver();
  let connection: MySqlConnection;
  try {
    connection = await driver.createConnection({ uri: rawUrl, connectTimeout: 10_000 });
  } catch (error) {
    // Only the message is printed (after scrubbing the password), never the cause.
    throw new Error(
      `Could not connect to ${target.display}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  try {
    const [rows] = await connection.query(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name IN (${TABLES.map(() => "?").join(", ")})`,
      TABLES.map((table) => prefix + table),
    );
    const existing = new Set((rows as { name: string }[]).map((row) => row.name));

    for (const [i, statement] of mysqlSchemaStatements(prefix).entries()) {
      await connection.query(statement);
      const table = prefix + TABLES[i];
      print(
        existing.has(table)
          ? `  ${out.dim("exists")}   ${table} ${out.dim("(left unchanged)")}`
          : `  ${out.green("created")}  ${table}`,
      );
    }
  } finally {
    await connection.end().catch(() => {});
  }

  print();
  print(
    `${out.green("Done.")} Next: call ${out.cyan("perms.sync()")} at startup to create your roles and permissions.`,
  );
}

interface Target {
  db: string;
  /** mysql://user@host:3306/database, without the password. */
  display: string;
}

function parseUrl(raw: string): Target {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Deliberately not echoing the value: it may contain a password.
    throw new UsageError(
      "The database URL is not valid. Expected mysql://user:password@host:3306/database",
    );
  }
  const protocol = url.protocol.replace(/:$/, "");
  if (protocol !== "mysql" && protocol !== "mariadb") {
    throw new UsageError(
      `Unsupported URL scheme "${protocol}:". permly migrate supports mysql:// (MySQL / MariaDB) for now.`,
    );
  }
  const database = safeDecode(url.pathname.replace(/^\//, ""));
  if (!database) {
    throw new UsageError(
      "The database URL has no database name, e.g. mysql://user:password@host:3306/mydb",
    );
  }
  const user = safeDecode(url.username);
  const display = `mysql://${user ? `${user}@` : ""}${url.hostname}:${url.port || "3306"}/${database}`;
  return { db: "mysql", display };
}

function checkPrefix(prefix: string | undefined): string {
  try {
    return validatePrefix(prefix ?? DEFAULT_PREFIX);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/** Uses the project's own mysql2, so permly never ships or pins a driver. */
function loadDriver(): MySqlDriver {
  try {
    return requireFromProject(process.cwd())("mysql2/promise") as MySqlDriver;
  } catch {
    throw new Error("mysql2 is not installed in this project. Install it with: npm install mysql2");
  }
}
