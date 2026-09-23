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
import mysql, { type Pool } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mysqlSchema } from "../../src/adapters/mysql-schema";
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

/** A throwaway project folder. `mysql2: "fake"` is enough for detection; "real" can connect. */
function project(
  options: { type?: "module"; ts?: boolean; src?: boolean; mysql2?: "fake" | "real" } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "permly-cli-"));
  temps.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "app", ...(options.type ? { type: options.type } : {}) }),
  );
  if (options.ts) writeFileSync(join(dir, "tsconfig.json"), "{}");
  if (options.src ?? true) mkdirSync(join(dir, "src"));
  if (options.mysql2 === "fake") {
    const pkg = join(dir, "node_modules/mysql2");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "mysql2", main: "index.js" }));
    writeFileSync(join(pkg, "index.js"), "module.exports = {};");
    writeFileSync(join(pkg, "promise.js"), "module.exports = {};");
  }
  if (options.mysql2 === "real") {
    mkdirSync(join(dir, "node_modules"));
    symlinkSync(join(ROOT, "node_modules/mysql2"), join(dir, "node_modules/mysql2"), "junction");
  }
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
    for (const file of ["index.js", "index.cjs", "mysql.js", "express.js", "memory.js"]) {
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
    [["init", "--db", "postgres"], 2, "postgres support is coming soon"],
    [["init", "--db", "oracle"], 2, 'Unknown database "oracle"'],
    [["init", "--db", "mysql", "--prefix", "bad-prefix"], 2, "Table prefix must contain only"],
  ])("fails clearly without a terminal: %j", async (args, code, message) => {
    const dir = project();
    const result = await cli(args, dir);
    expect(result.code).toBe(code);
    expect(result.stderr).toContain(message);
    expect(sqlFiles(dir)).toEqual([]);
  });
});

describe("init (interactive prompts)", () => {
  it("accepts the defaults", async () => {
    const dir = project({ ts: true });
    const result = await cli(["init"], dir, { input: ["", "", "", ""] });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("postgres (coming soon)");
    expect(result.stdout).toContain("Use these settings?");
    expect(existsSync(join(dir, "src/permly.ts"))).toBe(true);
    expect(sqlFiles(dir)).toHaveLength(1);
  });

  it("re-asks on unsupported or invalid answers", async () => {
    const dir = project();
    const result = await cli(["init"], dir, {
      input: ["2", "mongodb", "1", "bad-prefix", "app_", "db/sql", "maybe", "y"],
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("postgres support is coming soon");
    expect(result.stdout).toContain("mongodb support is coming soon");
    expect(result.stdout).toContain("Table prefix must contain only");
    expect(result.stdout).toContain("Please answer y or n.");
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
    [[], {}, 2, "No database URL"],
    [["--url", `not a url ${PASSWORD}`], {}, 2, "The database URL is not valid"],
    [["--url", `postgres://u:${PASSWORD}@h/db`], {}, 2, 'Unsupported URL scheme "postgres:"'],
    [["--url", `mysql://u:${PASSWORD}@h:3306/`], {}, 2, "has no database name"],
    [["--url", `mysql://u:${PASSWORD}@h/db`, "--prefix", "no-no"], {}, 2, "Table prefix"],
    [["--url", `mysql://u:${PASSWORD}@h/db`], {}, 2, "Pass --yes"],
  ] as const)("%j fails with exit %i", async (args, env, code, message) => {
    const result = await cli(["migrate", ...args], project({ mysql2: "real" }), { env });
    expect(result.code).toBe(code);
    expect(result.stderr).toContain(message);
    expect(result.all).not.toContain(PASSWORD);
  });

  it("explains how to install mysql2 when it is missing", async () => {
    const result = await cli(["migrate", "--yes"], project(), {
      env: { DATABASE_URL: `mysql://u:${PASSWORD}@127.0.0.1:1/db` },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("mysql2 is not installed in this project");
    expect(result.stderr).toContain("npm install mysql2");
  });

  it("reports an unreachable server without leaking the password", async () => {
    const result = await cli(
      ["migrate", "--yes", "--url", `mysql://root:${PASSWORD}@127.0.0.1:1/db`],
      project({ mysql2: "real" }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Could not connect to mysql://root@127.0.0.1:1/db");
    expect(result.all).not.toContain(PASSWORD);
  });
});

const targets = [
  [
    "MySQL 8",
    "PERMLY_MYSQL_URL",
    process.env.PERMLY_MYSQL_URL ?? "mysql://root:permly@127.0.0.1:33061/permly",
  ],
  [
    "MariaDB 11",
    "PERMLY_MARIADB_URL",
    process.env.PERMLY_MARIADB_URL ?? "mysql://root:permly@127.0.0.1:33062/permly",
  ],
] as const;

for (const [label, envVar, adminUrl] of targets) {
  const pool = await connectOrSkip(`${label} (CLI)`, envVar, async () => {
    const p = mysql.createPool({ uri: adminUrl, connectTimeout: 3000 });
    try {
      await p.query("SELECT 1");
      return p;
    } catch (error) {
      await p.end();
      throw error;
    }
  });

  describe.skipIf(!pool)(`migrate against ${label}`, () => {
    const admin = pool as Pool;
    const PASSWORD = "s3cret_Pw_42";
    const PREFIX = "cli_test_";
    const database = new URL(adminUrl).pathname.slice(1);
    const { hostname, port } = new URL(adminUrl);
    const url = `mysql://permly_cli:${PASSWORD}@${hostname}:${port}/${database}`;
    const tables = ["roles", "permissions", "role_permissions", "user_roles", "user_permissions"];

    const dropTables = async () => {
      for (const table of [...tables].reverse()) {
        await admin.query(`DROP TABLE IF EXISTS \`${PREFIX}${table}\``);
      }
    };
    const existingTables = async () => {
      const [rows] = await admin.query(
        `SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name LIKE 'cli\\_test\\_%'`,
      );
      return (rows as { name: string }[]).map((row) => row.name).sort();
    };

    beforeAll(async () => {
      // A dedicated user whose password we can look for in the output.
      await admin.query(`DROP USER IF EXISTS 'permly_cli'@'%'`);
      await admin.query(`CREATE USER 'permly_cli'@'%' IDENTIFIED BY '${PASSWORD}'`);
      await admin.query(`GRANT ALL ON \`${database}\`.* TO 'permly_cli'@'%'`);
      await dropTables();
    });

    afterAll(async () => {
      await dropTables();
      await admin.query(`DROP USER IF EXISTS 'permly_cli'@'%'`);
      await admin.end();
    });

    const migrate = (args: string[], options: Parameters<typeof cli>[2] = {}) =>
      cli(["migrate", "--prefix", PREFIX, ...args], project({ mysql2: "real" }), options);

    it("asks first, and creates nothing when the answer is no", async () => {
      const result = await migrate(["--url", url], { input: ["n"] });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(`mysql://permly_cli@${hostname}:${port}/${database}`);
      expect(result.stderr).toContain("Cancelled.");
      expect(await existingTables()).toEqual([]);
    });

    it("creates the tables, then is a no-op the second time", async () => {
      const first = await migrate(["--url", url], { input: ["y"] });
      expect(first.code).toBe(0);
      for (const table of tables)
        expect(first.stdout).toMatch(new RegExp(`created\\s+${PREFIX}${table}\\b`));
      expect(await existingTables()).toEqual(tables.map((t) => PREFIX + t).sort());

      // DATABASE_URL instead of --url, --yes instead of a prompt.
      const second = await migrate(["--yes"], { env: { DATABASE_URL: url } });
      expect(second.code).toBe(0);
      for (const table of tables)
        expect(second.stdout).toMatch(new RegExp(`exists\\s+${PREFIX}${table}\\b`));
      expect(second.stdout).not.toContain("created");

      for (const result of [first, second]) expect(result.all).not.toContain(PASSWORD);
    });

    it("keeps existing data (never drops or alters)", async () => {
      await admin.query(`INSERT INTO \`${PREFIX}roles\` (name) VALUES ('kept')`);
      expect((await migrate(["--yes", "--url", url])).code).toBe(0);
      const [rows] = await admin.query(`SELECT name FROM \`${PREFIX}roles\``);
      expect(rows).toEqual([{ name: "kept" }]);
    });

    it("never prints the password, even on authentication errors", async () => {
      const wrong = "wr0ng_Pw_99";
      const result = await migrate(["--yes", "--url", url.replace(PASSWORD, wrong)]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Could not connect");
      expect(result.all).not.toContain(wrong);
      expect(result.all).not.toContain(PASSWORD);
    });
  });
}
