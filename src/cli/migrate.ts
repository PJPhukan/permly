import { mongodbSetup, type MongoCollectionSpec } from "../adapters/mongodb-setup";
import { mysqlSchemaStatements } from "../adapters/mysql-schema";
import { postgresSchemaPlan } from "../adapters/postgres-schema";
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

// scheme://user:password@hosts/path?query, for every scheme we accept. Parsed by hand because
// MongoDB URLs can list several hosts (h1:27017,h2:27017), which WHATWG URL rejects.
const URL_PATTERN =
  /^([a-z][a-z0-9+.-]*):\/\/(?:([^:@/?#]*)(?::([^@/?#]*))?@)?([^/?#]*)(?:\/([^?#]*))?/i;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The password (raw and decoded) from a database URL, so error output can be scrubbed of it
 * even when it appears inside a driver's error message.
 */
export function urlSecrets(raw: string | undefined): string[] {
  const password = raw ? URL_PATTERN.exec(raw)?.[3] : undefined;
  if (!password) return [];
  return [...new Set([password, safeDecode(password)])].filter((secret) => secret.length > 0);
}

/** One table (SQL) or collection (MongoDB) and how to create it. */
interface Step {
  name: string;
}

/** What migrate needs from a database connection. */
interface Session<S extends Step> {
  steps: S[];
  /** Which step names already exist. */
  existing(): Promise<Set<string>>;
  /** Creates what's missing for one step; returns a note for the report, if any. */
  apply(step: S): Promise<string | undefined>;
  close(): Promise<void>;
}

export async function migrate(flags: Flags, prompter: Prompter | undefined): Promise<void> {
  const rawUrl = flags.url ?? process.env.DATABASE_URL;
  if (!rawUrl) {
    throw new UsageError(
      "No database URL. Set DATABASE_URL or pass --url, e.g. " +
        `${DRIVERS.mysql.urlExample}, ${DRIVERS.postgres.urlExample} or ${DRIVERS.mongodb.urlExample}`,
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
  const mongo = target.db === "mongodb";
  const names = mongo
    ? mongodbSetup(prefix).map((spec) => spec.name)
    : TABLES.map((table) => prefix + table);

  print(out.bold("permly migrate"));
  print();
  print(`  Database     ${target.display}`);
  if (target.db === "postgres") print(`  Schema       ${schema}`);
  print(`  ${mongo ? "Collections" : "Tables     "}  ${names.join(", ")}`);
  print(
    out.dim(
      `  Creates missing ${mongo ? "collections and indexes" : "tables"} only. Existing ones are never changed or dropped.`,
    ),
  );
  print();

  if (!flags.yes) {
    if (!prompter) {
      throw new UsageError("Pass --yes to confirm when running without a terminal (e.g. in CI).");
    }
    const what = mongo ? "collections and indexes" : "tables";
    if (!(await prompter.confirm(`Create the ${what}?`, false))) throw new CancelledError();
  }

  const session: Session<Step> =
    target.db === "postgres"
      ? await openPostgres(rawUrl, target.display, prefix, schema)
      : target.db === "mongodb"
        ? await openMongo(rawUrl, target.display, prefix)
        : await openMysql(rawUrl, target.display, prefix);

  try {
    const existing = await session.existing();
    for (const step of session.steps) {
      const note = await session.apply(step);
      print(
        existing.has(step.name)
          ? `  ${out.dim("exists")}   ${step.name} ${out.dim(note ? `(${note})` : "(left unchanged)")}`
          : `  ${out.green("created")}  ${step.name}`,
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

function loadDriver<T>(db: Database, modules: string[]): T {
  const load = requireFromProject(process.cwd());
  for (const module of modules) {
    try {
      return load(module) as T;
    } catch {
      // try the next one
    }
  }
  const { driver } = DRIVERS[db];
  const alternative = db === "mongodb" ? " (or mongoose)" : "";
  throw new Error(
    `${driver}${alternative} is not installed in this project. Install it with: npm install ${driver}`,
  );
}

function connectError(display: string, error: unknown): Error {
  // Only the message is printed (after scrubbing the password), never the cause.
  return new Error(
    `Could not connect to ${display}: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

interface SqlStep extends Step {
  statements: string[];
}

async function openMysql(url: string, display: string, prefix: string): Promise<Session<SqlStep>> {
  interface Connection {
    query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
    end(): Promise<void>;
  }
  const mysql = loadDriver<{
    createConnection(options: { uri: string; connectTimeout: number }): Promise<Connection>;
  }>("mysql", ["mysql2/promise"]);

  let connection: Connection;
  try {
    connection = await mysql.createConnection({ uri: url, connectTimeout: 10_000 });
  } catch (error) {
    throw connectError(display, error);
  }
  const steps = mysqlSchemaStatements(prefix).map((statement, i) => ({
    name: prefix + TABLES[i],
    statements: [statement],
  }));
  return {
    steps,
    async existing() {
      const names = steps.map((step) => step.name);
      const [rows] = await connection.query(
        `SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name IN (${names.map(() => "?").join(", ")})`,
        names,
      );
      return new Set((rows as { name: string }[]).map((row) => row.name));
    },
    async apply(step) {
      for (const statement of step.statements) await connection.query(statement);
      return undefined;
    },
    close: () => connection.end(),
  };
}

async function openPostgres(
  url: string,
  display: string,
  prefix: string,
  schema: string,
): Promise<Session<SqlStep>> {
  interface Client {
    connect(): Promise<void>;
    query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    end(): Promise<void>;
  }
  const pg = loadDriver<{
    Client: new (config: { connectionString: string; connectionTimeoutMillis: number }) => Client;
  }>("postgres", ["pg"]);

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

  const steps = postgresSchemaPlan(prefix, schema).map((plan) => ({
    name: plan.table,
    statements: plan.statements,
  }));
  return {
    steps,
    async existing() {
      const result = await client.query(
        `SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = ANY($2::text[])`,
        [schema, steps.map((step) => step.name)],
      );
      return new Set(result.rows.map((row) => String(row.name)));
    },
    async apply(step) {
      for (const statement of step.statements) await client.query(statement);
      return undefined;
    },
    close: () => client.end(),
  };
}

async function openMongo(
  url: string,
  display: string,
  prefix: string,
): Promise<Session<MongoCollectionSpec>> {
  interface Collection {
    listIndexes(): { toArray(): Promise<{ name: string }[]> };
    createIndexes(indexes: unknown[]): Promise<unknown>;
  }
  interface Db {
    listCollections(filter: object, options: object): { toArray(): Promise<{ name: string }[]> };
    createCollection(name: string): Promise<unknown>;
    collection(name: string): Collection;
  }
  interface Client {
    connect(): Promise<unknown>;
    db(): Db;
    close(): Promise<void>;
  }
  type ClientClass = new (url: string, options: object) => Client;
  // The native driver, or the copy inside mongoose.
  const driver = loadDriver<{ MongoClient?: ClientClass; mongo?: { MongoClient: ClientClass } }>(
    "mongodb",
    ["mongodb", "mongoose"],
  );
  const MongoClient = driver.MongoClient ?? driver.mongo?.MongoClient;
  if (!MongoClient) throw new Error("Could not find MongoClient in mongodb or mongoose.");

  const client = new MongoClient(url, { serverSelectionTimeoutMS: 10_000 });
  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => {});
    throw connectError(display, error);
  }
  const db = client.db();

  return {
    steps: mongodbSetup(prefix),
    async existing() {
      const collections = await db.listCollections({}, { nameOnly: true }).toArray();
      return new Set(collections.map((collection) => collection.name));
    },
    async apply(spec) {
      await db.createCollection(spec.name).catch((error: unknown) => {
        if ((error as { code?: unknown }).code !== 48) throw error; // NamespaceExists
      });
      const collection = db.collection(spec.name);
      const before = new Set((await collection.listIndexes().toArray()).map((index) => index.name));
      await collection.createIndexes(spec.indexes);
      const added = spec.indexes.filter((index) => !before.has(index.name));
      return added.length > 0
        ? `added index ${added.map((index) => index.name).join(", ")}`
        : undefined;
    },
    close: () => client.close(),
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
  mongodb: { db: "mongodb", port: "27017" },
  "mongodb+srv": { db: "mongodb", port: "" },
};

function parseUrl(raw: string): Target {
  const match = URL_PATTERN.exec(raw.trim());
  const examples = `${DRIVERS.mysql.urlExample}, ${DRIVERS.postgres.urlExample} or ${DRIVERS.mongodb.urlExample}`;
  if (!match || !match[4]) {
    // Deliberately not echoing the value: it may contain a password.
    throw new UsageError(`The database URL is not valid. Expected e.g. ${examples}`);
  }
  const [, rawScheme = "", user = "", , hosts = "", path = ""] = match;
  const protocol = rawScheme.toLowerCase();
  const scheme = SCHEMES[protocol];
  if (!scheme) {
    throw new UsageError(
      `Unsupported URL scheme "${protocol}:". Use mysql://, mariadb://, postgres://, postgresql://, mongodb:// or mongodb+srv://.`,
    );
  }
  const database = safeDecode(path);
  if (!database) {
    throw new UsageError(
      `The database URL has no database name, e.g. ${DRIVERS[scheme.db].urlExample}`,
    );
  }
  // Show a default port only for single-host URLs that don't give one.
  const host =
    !scheme.port || hosts.includes(":") || hosts.includes(",") ? hosts : `${hosts}:${scheme.port}`;
  const name = safeDecode(user);
  return { db: scheme.db, display: `${protocol}://${name ? `${name}@` : ""}${host}/${database}` };
}

function toUsage<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}
