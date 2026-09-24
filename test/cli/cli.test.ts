import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import mysql from "mysql2/promise";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mysqlSchema } from "../../src/adapters/mysql-schema";
import { postgresSchema } from "../../src/adapters/postgres-schema";
import { connectOrSkip } from "../adapters/db";

const ROOT = resolve(import.meta.dirname, "../..");
const CLI = join(ROOT, "dist/cli.js");
const VERSION = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }
).version;

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout + stderr */
  all: string;
}

/**
 * Runs the built CLI. Without `input`, stdin is closed and not a terminal (like CI).
 * With `input`, the prompts are enabled and each string is typed as one line.
 */
function cli(
  args: string[],
  cwd: string,
  options: { input?: string[]; env?: Record<string, string> } = {},
): Promise<Result> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !["DATABASE_URL", "PERMLY_CLI_INTERACTIVE"].includes(key)) {
      env[key] = value;
    }
  }
  if (options.input) env.PERMLY_CLI_INTERACTIVE = "1";
  Object.assign(env, options.env);

  const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  if (options.input) child.stdin.write(options.input.map((line) => `${line}\n`).join(""));
  child.stdin.end();
  return new Promise((done) => {
    child.on("close", (code) => done({ code, stdout, stderr, all: stdout + stderr }));
  });
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Install = "fake" | "real";

/**
 * A throwaway project folder. A "fake" driver is enough for detection; a "real" one (linked
 * from this repo) can connect. `permly: true` links this repo's built package in.
 */
function project(
  options: {
    type?: "module";
    ts?: boolean;
    src?: boolean;
    mysql2?: Install;
    pg?: Install;
    permly?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "permly-cli-"));
  temps.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "app", ...(options.type ? { type: options.type } : {}) }),
  );
  if (options.ts) writeFileSync(join(dir, "tsconfig.json"), "{}");
  if (options.src ?? true) mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "node_modules"));
  const link = (name: string, target: string) =>
    symlinkSync(target, join(dir, "node_modules", name), "junction");
  for (const driver of ["mysql2", "pg"] as const) {
    if (options[driver] === "fake") {
      const pkg = join(dir, "node_modules", driver);
      mkdirSync(pkg);
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: driver, main: "index.js" }));
      writeFileSync(join(pkg, "index.js"), "module.exports = {};");
      writeFileSync(join(pkg, "promise.js"), "module.exports = {};");
    }
    if (options[driver] === "real") link(driver, join(ROOT, "node_modules", driver));
  }
  if (options.permly) link("permly", ROOT);
  return dir;
}

const sqlFiles = (dir: string, out = "migrations") =>
  existsSync(join(dir, out)) ? readdirSync(join(dir, out)) : [];
const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
/** `node --check`: the generated JavaScript parses in the module format Node will use. */
const parses = (file: string) => spawnSync(process.execPath, ["--check", file]).status === 0;

describe("general", () => {
  it("--help and --version exit 0", async () => {
    const dir = project();
    const help = await cli(["--help"], dir);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("npx permly init");
    expect(help.stdout).toContain("npx permly migrate");
    expect(await cli(["--version"], dir)).toMatchObject({ code: 0, stdout: `${VERSION}\n` });
    expect((await cli(["init", "-h"], dir)).code).toBe(0);
  });

  it.each([
    [[], "Missing command"],
    [["deploy"], 'Unknown command "deploy"'],
    [["init", "--wat"], "Unknown option '--wat'"],
    [["init", "extra"], 'Unexpected argument "extra"'],
    [["init", "--ts", "--js"], "either --ts or --js"],
    [["init", "--esm", "--cjs"], "either --esm or --cjs"],
    [["init", "--db"], "argument missing"],
  ])("bad usage %j exits 2", async (args, message) => {
    const result = await cli(args, project());
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain("npx permly --help");
  });

  it("never prints color codes when output is not a terminal", async () => {
    const result = await cli(["init", "--db", "mysql"], project());
    expect(result.all).not.toContain("\x1b[");
  });

  it("the library entries never load the CLI", () => {
    for (const file of [
      "index.js",
      "index.cjs",
      "mysql.js",
      "postgres.js",
      "express.js",
      "memory.js",
    ]) {
      const code = read(join(ROOT, "dist"), file);
      expect(code, file).not.toMatch(/readline|parseArgs|permly init/);
    }
  });
});

describe("init (non-interactive)", () => {
  it("TypeScript project: permly.ts + schema from mysqlSchema()", async () => {
    const dir = project({ ts: true, type: "module", mysql2: "fake" });
    const result = await cli(["init", "--db", "mysql"], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Detected: TypeScript · mysql2 installed");
    expect(result.stdout).not.toContain("npm install mysql2");

    const [sql] = sqlFiles(dir);
    expect(sql).toMatch(/^\d{14}_permly_init\.sql$/);
    const schema = read(dir, `migrations/${sql}`);
    expect(schema).toContain(mysqlSchema()); // the same SQL as the adapter, not a copy
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS `perm_roles`");

    const starter = read(dir, "src/permly.ts");
    expect(starter).toContain(`import { mysqlAdapter } from "permly/mysql";`);
    expect(starter).toContain("export async function setupPermissions(): Promise<void>");
    expect(starter).toContain("mysqlAdapter(createPool(url))");
  });

  it("JavaScript ES modules project: permly.js with import", async () => {
    const dir = project({ type: "module" });
    expect((await cli(["init", "--db", "mysql"], dir)).stdout).toContain("JavaScript (ES modules)");
    const starter = read(dir, "src/permly.js");
    expect(starter).toContain(`import { createPermissions } from "permly";`);
    expect(starter).toContain("export const perms");
    expect(parses(join(dir, "src/permly.js"))).toBe(true);
  });

  it("JavaScript CommonJS project: permly.js with require", async () => {
    const dir = project();
    expect((await cli(["init", "--db", "mysql"], dir)).stdout).toContain("JavaScript (CommonJS)");
    const starter = read(dir, "src/permly.js");
    expect(starter).toContain(`const { createPermissions } = require("permly");`);
    expect(starter).toContain("module.exports = { perms, setupPermissions };");
    expect(parses(join(dir, "src/permly.js"))).toBe(true);
  });

  it("uses .mjs / .cjs when the flag differs from the project's module type", async () => {
    const cjsProject = project();
    await cli(["init", "--db", "mysql", "--esm"], cjsProject);
    expect(parses(join(cjsProject, "src/permly.mjs"))).toBe(true);

    const esmProject = project({ type: "module" });
    await cli(["init", "--db", "mysql", "--cjs"], esmProject);
    expect(parses(join(esmProject, "src/permly.cjs"))).toBe(true);
  });

  it("--js overrides a detected TypeScript project, and no src/ means the project root", async () => {
    const dir = project({ ts: true, src: false });
    await cli(["init", "--db", "mysql", "--js"], dir);
    expect(existsSync(join(dir, "permly.js"))).toBe(true);
  });

  it("prints the install command when mysql2 is missing", async () => {
    const result = await cli(["init", "--db", "mysql"], project());
    expect(result.stdout).toContain("mysql2 not installed");
    expect(result.stdout).toContain("npm install mysql2");
  });

  it("applies --prefix and --out everywhere", async () => {
    const dir = project();
    const result = await cli(["init", "--db", "mysql", "--prefix", "app_", "--out", "db/sql"], dir);
    expect(result.code).toBe(0);
    const [sql] = sqlFiles(dir, "db/sql");
    expect(read(dir, `db/sql/${sql}`)).toContain("`app_roles`");
    expect(read(dir, "src/permly.js")).toContain(
      `mysqlAdapter(createPool(url), { prefix: "app_" })`,
    );
    expect(result.stdout).toContain("npx permly migrate --prefix app_");
  });

  it("never overwrites without --force, and reuses the migration name", async () => {
    const dir = project();
    await cli(["init", "--db", "mysql"], dir);
    writeFileSync(join(dir, "src/permly.js"), "// my edits");
    const [sql] = sqlFiles(dir);

    const refused = await cli(["init", "--db", "mysql"], dir);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("These files already exist");
    expect(refused.stderr).toContain("--force");
    expect(read(dir, "src/permly.js")).toBe("// my edits");

    const forced = await cli(["init", "--db", "mysql", "--force"], dir);
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain("replaced");
    expect(read(dir, "src/permly.js")).not.toBe("// my edits");
    expect(sqlFiles(dir)).toEqual([sql]); // still one migration
  });

  it.each([
    [["init"], 2, "Missing --db"],
    [["init", "--db", "mongodb"], 2, "mongodb support is coming soon"],
    [["init", "--db", "oracle"], 2, 'Unknown database "oracle"'],
    [["init", "--db", "mysql", "--prefix", "bad-prefix"], 2, "Table prefix must contain only"],
    [["init", "--db", "mysql", "--schema", "x"], 2, "--schema is only used with Postgres"],
    [["init", "--db", "postgres", "--schema", "bad schema"], 2, "Schema must be 1-63"],
  ])("fails clearly without a terminal: %j", async (args, code, message) => {
    const dir = project();
    const result = await cli(args, dir);
    expect(result.code).toBe(code);
    expect(result.stderr).toContain(message);
    expect(sqlFiles(dir)).toEqual([]);
  });
});

describe("init for Postgres", () => {
  it("TypeScript: pg Pool, postgresAdapter, schema from postgresSchema()", async () => {
    const dir = project({ ts: true, type: "module", pg: "fake" });
    const result = await cli(["init", "--db", "postgres"], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Detected: TypeScript · pg installed");
    expect(result.stdout).not.toContain("npm install pg");
    expect(result.stdout).toContain("postgres://user:password@localhost:5432/mydb");

    const [sql] = sqlFiles(dir);
    expect(read(dir, `migrations/${sql}`)).toContain(postgresSchema());
    const starter = read(dir, "src/permly.ts");
    expect(starter).toContain(`import pg from "pg";`);
    expect(starter).toContain(`import { postgresAdapter } from "permly/postgres";`);
    expect(starter).toContain("postgresAdapter(new pg.Pool({ connectionString: url }))");
  });

  it("JavaScript ES modules and CommonJS starters parse", async () => {
    const esm = project({ type: "module" });
    await cli(["init", "--db", "postgres"], esm);
    expect(parses(join(esm, "src/permly.js"))).toBe(true);

    const cjs = project();
    await cli(["init", "--db", "postgres"], cjs);
    const starter = read(cjs, "src/permly.js");
    expect(starter).toContain(`const { Pool } = require("pg");`);
    expect(starter).toContain("postgresAdapter(new Pool({ connectionString: url }))");
    expect(parses(join(cjs, "src/permly.js"))).toBe(true);
  });

  it("applies --schema and --prefix, accepts the postgresql alias, hints to install pg", async () => {
    const dir = project();
    const result = await cli(
      ["init", "--db", "postgresql", "--schema", "tenant1", "--prefix", "app_"],
      dir,
    );
    expect(result.code).toBe(0);
    const [sql] = sqlFiles(dir);
    expect(read(dir, `migrations/${sql}`)).toContain(`"tenant1"."app_roles"`);
    expect(read(dir, "src/permly.js")).toContain(`{ prefix: "app_", schema: "tenant1" }`);
    expect(result.stdout).toContain("pg not installed");
    expect(result.stdout).toContain("npm install pg");
    expect(result.stdout).toContain("npx permly migrate --prefix app_ --schema tenant1");
  });
});

describe("the generated setupPermissions()", () => {
  it("only grants defaults to roles sync() just created", async () => {
    const dir = project({ type: "module" });
    await cli(["init", "--db", "mysql"], dir);
    const starter = read(dir, "src/permly.js");
    expect(starter).toContain("const { createdRoles } = await perms.sync();");
    expect(starter).toContain(`if (createdRoles.includes("admin")) {`);
    expect(starter).toContain("kept across restarts");
  });
});

describe("init (interactive prompts)", () => {
  it("accepts the defaults", async () => {
    const dir = project({ ts: true });
    const result = await cli(["init"], dir, { input: ["", "", "", ""] });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("2) postgres");
    expect(result.stdout).toContain("mongodb (coming soon)");
    expect(result.stdout).toContain("Use these settings?");
    expect(existsSync(join(dir, "src/permly.ts"))).toBe(true);
    expect(read(dir, "src/permly.ts")).toContain("mysqlAdapter");
  });

  it("asks for the schema when Postgres is chosen", async () => {
    const dir = project();
    const result = await cli(["init"], dir, {
      input: ["2", "", "bad schema!", "tenant1", "", ""],
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Postgres schema?");
    expect(result.stdout).toContain("Schema must be 1-63");
    const [sql] = sqlFiles(dir);
    expect(read(dir, `migrations/${sql}`)).toContain(`"tenant1"."perm_roles"`);
  });

  it("re-asks on unsupported or invalid answers", async () => {
    const dir = project();
    const result = await cli(["init"], dir, {
      input: ["3", "mongodb", "1", "bad-prefix", "app_", "db/sql", "maybe", "y"],
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("mongodb support is coming soon");
    expect(result.stdout).toContain("Table prefix must contain only");
    expect(result.stdout).toContain("Please answer y or n.");
    expect(result.stdout).not.toContain("Postgres schema?");
    const [sql] = sqlFiles(dir, "db/sql");
    expect(read(dir, `db/sql/${sql}`)).toContain("`app_roles`");
  });

  it("lets the user correct the detected settings", async () => {
    const dir = project({ ts: true }); // detected as TypeScript
    const result = await cli(["init"], dir, { input: ["", "", "", "n", "js", "cjs"] });
    expect(result.code).toBe(0);
    expect(read(dir, "src/permly.js")).toContain("require(");
  });

  it("does not confirm settings that came from flags", async () => {
    const dir = project();
    const result = await cli(["init", "--ts", "--prefix", "x_", "--out", "sql"], dir, {
      input: [""],
    });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("Use these settings?");
    expect(existsSync(join(dir, "src/permly.ts"))).toBe(true);
  });

  it("asks before overwriting each existing file", async () => {
    const dir = project();
    await cli(["init", "--db", "mysql"], dir);
    const [sql] = sqlFiles(dir);
    writeFileSync(join(dir, `migrations/${sql}`), "-- mine");
    writeFileSync(join(dir, "src/permly.js"), "// mine");

    // defaults x4, then: keep the SQL file, overwrite the starter.
    const result = await cli(["init"], dir, { input: ["", "", "", "", "n", "y"] });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("already exists. Overwrite?");
    expect(read(dir, `migrations/${sql}`)).toBe("-- mine");
    expect(read(dir, "src/permly.js")).not.toBe("// mine");
  });

  it("cancels cleanly when input ends (Ctrl+D) and writes nothing", async () => {
    const dir = project();
    const result = await cli(["init"], dir, { input: ["mysql"] });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Cancelled.");
    expect(sqlFiles(dir)).toEqual([]);
  });
});

describe("migrate (no database needed)", () => {
  const PASSWORD = "s3cret_Pw_42";

  it.each([
    [[], 2, "No database URL"],
    [["--url", `not a url ${PASSWORD}`], 2, "The database URL is not valid"],
    [["--url", `sqlite://u:${PASSWORD}@h/db`], 2, 'Unsupported URL scheme "sqlite:"'],
    [["--url", `mysql://u:${PASSWORD}@h:3306/`], 2, "has no database name"],
    [["--url", `mysql://u:${PASSWORD}@h/db`, "--prefix", "no-no"], 2, "Table prefix"],
    [
      ["--url", `mysql://u:${PASSWORD}@h/db`, "--schema", "x"],
      2,
      "--schema is only used with Postgres",
    ],
    [["--url", `postgres://u:${PASSWORD}@h/db`, "--db", "mysql"], 2, "doesn't match the URL"],
    [["--url", `postgres://u:${PASSWORD}@h/db`, "--schema", "no way"], 2, "Schema must be 1-63"],
    [["--url", `mysql://u:${PASSWORD}@h/db`], 2, "Pass --yes"],
    [["--url", `postgresql://u:${PASSWORD}@h/db`], 2, "Pass --yes"],
  ] as const)("%j fails with exit %i", async (args, code, message) => {
    const result = await cli(["migrate", ...args], project({ mysql2: "real", pg: "real" }));
    expect(result.code).toBe(code);
    expect(result.stderr).toContain(message);
    expect(result.all).not.toContain(PASSWORD);
  });

  it.each([
    ["mysql2", `mysql://u:${PASSWORD}@127.0.0.1:1/db`],
    ["pg", `postgres://u:${PASSWORD}@127.0.0.1:1/db`],
  ])("explains how to install %s when it is missing", async (driver, url) => {
    const result = await cli(["migrate", "--yes"], project(), { env: { DATABASE_URL: url } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${driver} is not installed in this project`);
    expect(result.stderr).toContain(`npm install ${driver}`);
  });

  it.each([
    ["mysql", "mysql://root@127.0.0.1:1/db"],
    ["postgres", "postgres://root@127.0.0.1:1/db"],
  ])("reports an unreachable %s server without leaking the password", async (scheme, shown) => {
    const result = await cli(
      ["migrate", "--yes", "--url", `${scheme}://root:${PASSWORD}@127.0.0.1:1/db`],
      project({ mysql2: "real", pg: "real" }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Could not connect to ${shown}`);
    expect(result.all).not.toContain(PASSWORD);
  });
});

// --- against real databases ---

interface Admin {
  query(sql: string): Promise<Record<string, unknown>[]>;
  end(): Promise<void>;
}

interface DbTarget {
  label: string;
  envVar: string;
  adminUrl: string;
  kind: "mysql" | "postgres";
  /** Appended to URLs given to the CLI and the starter file. */
  urlSuffix: string;
}

const dbTargets: DbTarget[] = [
  {
    label: "MySQL 8",
    envVar: "PERMLY_MYSQL_URL",
    adminUrl: process.env.PERMLY_MYSQL_URL ?? "mysql://root:permly@127.0.0.1:33061/permly",
    kind: "mysql",
    urlSuffix: "",
  },
  {
    label: "MariaDB 11",
    envVar: "PERMLY_MARIADB_URL",
    adminUrl: process.env.PERMLY_MARIADB_URL ?? "mysql://root:permly@127.0.0.1:33062/permly",
    kind: "mysql",
    urlSuffix: "",
  },
  {
    label: "Postgres 13",
    envVar: "PERMLY_PG13_URL",
    adminUrl: process.env.PERMLY_PG13_URL ?? "postgres://postgres:permly@127.0.0.1:54313/permly",
    kind: "postgres",
    urlSuffix: "",
  },
  {
    label: "Postgres 17 (SSL)",
    envVar: "PERMLY_PG17_URL",
    adminUrl: process.env.PERMLY_PG17_URL ?? "postgres://postgres:permly@127.0.0.1:54317/permly",
    kind: "postgres",
    // Self-signed test certificate: encrypt, but don't verify it.
    urlSuffix: "?sslmode=no-verify",
  },
];

async function openAdmin(target: DbTarget): Promise<Admin> {
  if (target.kind === "mysql") {
    const pool = mysql.createPool({ uri: target.adminUrl, connectTimeout: 3000 });
    const admin: Admin = {
      query: async (sql) => (await pool.query(sql))[0] as Record<string, unknown>[],
      end: () => pool.end(),
    };
    await admin.query("SELECT 1").catch(async (error: unknown) => {
      await pool.end();
      throw error;
    });
    return admin;
  }
  const pool = new pg.Pool({
    connectionString: target.adminUrl + target.urlSuffix,
    connectionTimeoutMillis: 3000,
  });
  const admin: Admin = {
    query: async (sql) => (await pool.query(sql)).rows as Record<string, unknown>[],
    end: () => pool.end(),
  };
  await admin.query("SELECT 1").catch(async (error: unknown) => {
    await pool.end();
    throw error;
  });
  return admin;
}

const TABLES = ["roles", "permissions", "role_permissions", "user_roles", "user_permissions"];

for (const target of dbTargets) {
  const admin = await connectOrSkip(`${target.label} (CLI)`, target.envVar, () =>
    openAdmin(target),
  );

  describe.skipIf(!admin)(`against ${target.label}`, () => {
    const db = admin as Admin;
    const { kind, urlSuffix } = target;
    const PASSWORD = "s3cret_Pw_42";
    const PREFIX = "cli_test_";
    const adminUrl = new URL(target.adminUrl);
    const database = adminUrl.pathname.slice(1);
    const hostPort = `${adminUrl.hostname}:${adminUrl.port}`;
    const scheme = kind === "mysql" ? "mysql" : "postgres";
    const url = `${scheme}://permly_cli:${PASSWORD}@${hostPort}/${database}${urlSuffix}`;
    const q = (name: string) => (kind === "mysql" ? `\`${name}\`` : `"${name}"`);

    const dropTables = async (prefix: string, schema = "public") => {
      for (const table of [...TABLES].reverse()) {
        const name = kind === "mysql" ? q(prefix + table) : `${q(schema)}.${q(prefix + table)}`;
        await db.query(`DROP TABLE IF EXISTS ${name}`);
      }
    };
    const tablesLike = async (prefix: string, schema = "public") => {
      const where = kind === "mysql" ? "table_schema = DATABASE()" : `table_schema = '${schema}'`;
      const rows = await db.query(
        `SELECT table_name AS name FROM information_schema.tables
         WHERE ${where} AND table_name LIKE '${prefix.replace(/_/g, "\\_")}%'`,
      );
      return rows.map((row) => String(row.name)).sort();
    };
    const dropUser = async () => {
      if (kind === "mysql") {
        await db.query(`DROP USER IF EXISTS 'permly_cli'@'%'`);
      } else {
        await db.query(`DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'permly_cli') THEN
            DROP OWNED BY permly_cli; DROP ROLE permly_cli;
          END IF; END $$`);
      }
    };

    beforeAll(async () => {
      // A dedicated user whose password we can look for in the output.
      await dropTables(PREFIX);
      await dropTables("restart_test_");
      await dropUser();
      if (kind === "mysql") {
        await db.query(`CREATE USER 'permly_cli'@'%' IDENTIFIED BY '${PASSWORD}'`);
        await db.query(`GRANT ALL ON \`${database}\`.* TO 'permly_cli'@'%'`);
      } else {
        await db.query(`CREATE ROLE permly_cli LOGIN PASSWORD '${PASSWORD}'`);
        await db.query(`GRANT USAGE, CREATE ON SCHEMA public TO permly_cli`);
      }
    });

    afterAll(async () => {
      await dropTables(PREFIX);
      await dropTables("restart_test_");
      await dropUser();
      await db.end();
    });

    const driverOption = kind === "mysql" ? { mysql2: "real" as const } : { pg: "real" as const };
    const migrate = (args: string[], options: Parameters<typeof cli>[2] = {}) =>
      cli(["migrate", "--prefix", PREFIX, ...args], project(driverOption), options);

    it("asks first, and creates nothing when the answer is no", async () => {
      const result = await migrate(["--url", url], { input: ["n"] });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(`${scheme}://permly_cli@${hostPort}/${database}`);
      expect(result.stderr).toContain("Cancelled.");
      expect(await tablesLike(PREFIX)).toEqual([]);
    });

    it("creates the tables, then is a no-op the second time", async () => {
      const first = await migrate(["--url", url], { input: ["y"] });
      expect(first.code, first.all).toBe(0);
      for (const table of TABLES) {
        expect(first.stdout).toMatch(new RegExp(`created\\s+${PREFIX}${table}\\b`));
      }
      expect(await tablesLike(PREFIX)).toEqual(TABLES.map((t) => PREFIX + t).sort());

      // DATABASE_URL instead of --url, --yes instead of a prompt.
      const second = await migrate(["--yes"], { env: { DATABASE_URL: url } });
      expect(second.code).toBe(0);
      for (const table of TABLES) {
        expect(second.stdout).toMatch(new RegExp(`exists\\s+${PREFIX}${table}\\b`));
      }
      expect(second.stdout).not.toContain("created");

      for (const result of [first, second]) expect(result.all).not.toContain(PASSWORD);
    });

    it("keeps existing data (never drops or alters)", async () => {
      await db.query(`INSERT INTO ${q(PREFIX + "roles")} (name) VALUES ('kept')`);
      expect((await migrate(["--yes", "--url", url])).code).toBe(0);
      expect(await db.query(`SELECT name FROM ${q(PREFIX + "roles")}`)).toEqual([{ name: "kept" }]);
    });

    it("never prints the password, even on authentication errors", async () => {
      const wrong = "wr0ng_Pw_99";
      const result = await migrate(["--yes", "--url", url.replace(PASSWORD, wrong)]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Could not connect");
      expect(result.all).not.toContain(wrong);
      expect(result.all).not.toContain(PASSWORD);
    });

    if (kind === "postgres") {
      it("requires an existing schema, then creates the tables inside it", async () => {
        await db.query(`DROP SCHEMA IF EXISTS tenant_x CASCADE`);
        const missing = await migrate(["--yes", "--schema", "tenant_x", "--url", url]);
        expect(missing.code).toBe(1);
        expect(missing.stderr).toContain(`Schema "tenant_x" does not exist`);
        expect(missing.stderr).toContain(`CREATE SCHEMA "tenant_x";`);

        await db.query(`CREATE SCHEMA tenant_x AUTHORIZATION permly_cli`);
        try {
          const created = await migrate(["--yes", "--schema", "tenant_x", "--url", url]);
          expect(created.code, created.all).toBe(0);
          expect(created.stdout).toContain("Schema    tenant_x");
          expect(await tablesLike(PREFIX, "tenant_x")).toEqual(
            TABLES.map((t) => PREFIX + t).sort(),
          );
        } finally {
          await db.query(`DROP SCHEMA tenant_x CASCADE`);
        }
      });
    }

    it("setupPermissions() keeps a revoked permission revoked after a restart", async () => {
      const dir = project({ type: "module", permly: true, ...driverOption });
      const env = { DATABASE_URL: url };
      const flags = ["--db", kind, "--prefix", "restart_test_"];
      expect((await cli(["init", ...flags], dir)).code).toBe(0);
      expect((await cli(["migrate", "--yes", ...flags], dir, { env })).code).toBe(0);

      // Each script is a separate process, i.e. an app start with an empty cache.
      const start = (body: string) => {
        writeFileSync(
          join(dir, "start.mjs"),
          `import { perms, setupPermissions } from "./src/permly.js";
           await setupPermissions();
           ${body}
           process.exit(0);`,
        );
        const result = spawnSync(process.execPath, ["start.mjs"], {
          cwd: dir,
          env: { ...process.env, ...env },
          encoding: "utf8",
        });
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout) as Record<string, string[]>;
      };
      const show = `console.log(JSON.stringify({
        editor: await perms.role("editor").getPermissions(),
        admin: await perms.role("admin").getPermissions(),
      }));`;

      // First start: defaults granted. Then an admin revokes one.
      expect(start(show)).toEqual({ editor: ["posts.create", "posts.edit.own"], admin: ["*"] });
      start(`await perms.role("editor").revokePermission("posts.create"); console.log("{}");`);

      // Restart: the revoke survives, nothing else changes.
      expect(start(show)).toEqual({ editor: ["posts.edit.own"], admin: ["*"] });
    });
  });
}
