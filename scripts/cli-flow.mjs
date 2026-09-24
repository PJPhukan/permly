// The "new user" flow from the packed tarball, in fresh folders, for each database:
//   npm install permly <driver>  →  npx permly init  →  npx permly migrate  →  sync() and can(),
// then a second start proving a revoked permission stays revoked.
// Used by examples-test.mjs.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import mysql from "mysql2/promise";
import pg from "pg";

const isWindows = process.platform === "win32";
const npm = isWindows ? "npm.cmd" : "npm";
const npx = isWindows ? "npx.cmd" : "npx";
const TABLES = ["user_permissions", "user_roles", "role_permissions", "permissions", "roles"];

// Windows needs a shell to run .cmd files.
function run(cmd, args, cwd, env = {}) {
  return execFileSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    shell: isWindows,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

const databases = [
  {
    db: "mysql",
    driver: "mysql2",
    url: process.env.EXAMPLES_DATABASE_URL ?? "mysql://root:permly@127.0.0.1:33061/permly",
    envVar: "EXAMPLES_DATABASE_URL",
    async query(url, sql) {
      const connection = await mysql.createConnection({ uri: url, connectTimeout: 3000 });
      try {
        await connection.query(sql);
      } finally {
        await connection.end();
      }
    },
    quote: (name) => `\`${name}\``,
  },
  {
    db: "postgres",
    driver: "pg",
    // The docker-compose Postgres 17 uses SSL with a self-signed certificate.
    url:
      process.env.EXAMPLES_POSTGRES_URL ??
      "postgres://postgres:permly@127.0.0.1:54317/permly?sslmode=no-verify",
    envVar: "EXAMPLES_POSTGRES_URL",
    async query(url, sql) {
      const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
      await client.connect();
      try {
        await client.query(sql);
      } finally {
        await client.end();
      }
    },
    quote: (name) => `"${name}"`,
  },
];

// First start: defaults are granted, then an admin revokes one. Second start: it stays revoked.
const FIRST = `
await setupPermissions();
await perms.user(1).assignRole("editor");
await perms.user(2).assignRole("admin");
const results = [
  await perms.user(1).can("posts.create"),
  !(await perms.user(1).can("posts.delete")),
  await perms.user(1).canOwn("posts.edit", 1),
  await perms.user(2).can("posts.delete"),
];
await perms.role("editor").revokePermission("posts.create");
console.log(results.every(Boolean) ? "PERMLY_OK" : "PERMLY_FAIL " + JSON.stringify(results));
process.exit(0); // the starter's pool would otherwise keep the process alive
`;
const SECOND = `
await setupPermissions();
const kept = !(await perms.user(1).can("posts.create")) && (await perms.user(2).can("posts.create"));
console.log(kept ? "PERMLY_OK" : "PERMLY_FAIL revoked permission came back after restart");
process.exit(0);
`;

const variants = [
  {
    name: "JavaScript ES modules",
    packageJson: { type: "module" },
    files: {
      "first.js": `import { perms, setupPermissions } from "./src/permly.js";\n${FIRST}`,
      "second.js": `import { perms, setupPermissions } from "./src/permly.js";\n${SECOND}`,
    },
    runs: [["first.js"], ["second.js"]],
  },
  {
    name: "JavaScript CommonJS",
    packageJson: {},
    files: {
      "first.js": `const { perms, setupPermissions } = require("./src/permly.js");\n(async () => {${FIRST}})();`,
      "second.js": `const { perms, setupPermissions } = require("./src/permly.js");\n(async () => {${SECOND}})();`,
    },
    runs: [["first.js"], ["second.js"]],
  },
  {
    name: "TypeScript",
    packageJson: { type: "module" },
    devDependencies: (driver) => [
      "typescript@~5.9",
      "@types/node@22",
      ...(driver === "pg" ? ["@types/pg"] : []),
    ],
    files: {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          strict: true,
          skipLibCheck: false,
          outDir: "dist",
          rootDir: "src",
          types: ["node"],
        },
      }),
      "src/first.ts": `import { perms, setupPermissions } from "./permly.js";\n${FIRST}`,
      "src/second.ts": `import { perms, setupPermissions } from "./permly.js";\n${SECOND}`,
    },
    // Also type-check the generated file with the older resolution modes users still have.
    typecheck: [
      ["--module", "commonjs", "--moduleResolution", "node10"],
      ["--module", "esnext", "--moduleResolution", "bundler"],
    ],
    build: true,
    runs: [["dist/first.js"], ["dist/second.js"]],
  },
];

async function reachable(database) {
  try {
    await database.query(database.url, "SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/** Returns false if the flow failed. */
export async function testCliFlow({ tarball, work }) {
  let ok = true;
  for (const database of databases) {
    if (!(await reachable(database))) {
      const message = `CLI flow for ${database.db} needs a database at ${database.envVar} (default: docker compose).`;
      if (process.env.PERMLY_REQUIRE_DB === "1") {
        console.error(`✗ ${message}`);
        ok = false;
      } else {
        console.log(`⚠ Skipping: ${message}`);
      }
      continue;
    }

    for (const [i, variant] of variants.entries()) {
      const dir = join(work, `cli-${database.db}-${i}`);
      const prefix = `permly_smoke${i}_${Date.now() % 100000}_`;
      const env = { DATABASE_URL: database.url };
      const label = `CLI flow, ${database.db}, ${variant.name}`;
      try {
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "fresh-app", private: true, ...variant.packageJson }),
        );
        for (const [file, content] of Object.entries(variant.files)) {
          writeFileSync(join(dir, file), content);
        }

        const quiet = ["--no-audit", "--no-fund", "--loglevel=error"];
        run(npm, ["install", ...quiet, tarball, database.driver], dir);
        if (variant.devDependencies) {
          run(npm, ["install", ...quiet, "-D", ...variant.devDependencies(database.driver)], dir);
        }

        const flags = ["--db", database.db, "--prefix", prefix];
        run(npx, ["permly", "init", ...flags], dir);
        const migrated = run(npx, ["permly", "migrate", "--yes", ...flags], dir, env);
        if (!migrated.includes(`created  ${prefix}roles`)) throw new Error(`migrate:\n${migrated}`);

        for (const tscFlags of variant.typecheck ?? []) {
          const common = ["--noEmit", "--strict", "--esModuleInterop", "--types", "node"];
          run(npx, ["tsc", ...common, ...tscFlags, "src/permly.ts"], dir);
        }
        if (variant.build) run(npx, ["tsc"], dir);

        for (const args of variant.runs) {
          const output = run(process.execPath, args, dir, env);
          if (!output.includes("PERMLY_OK")) throw new Error(`${args.join(" ")}: ${output}`);
        }
        console.log(`✓ ${label}: init → migrate → sync() → can() → restart keeps changes`);
      } catch (error) {
        ok = false;
        const details = [error.message, error.stdout, error.stderr].filter(Boolean).join("\n");
        console.error(`✗ ${label}:\n${details}`);
      } finally {
        for (const table of TABLES) {
          await database.query(
            database.url,
            `DROP TABLE IF EXISTS ${database.quote(prefix + table)}`,
          );
        }
      }
    }
  }
  return ok;
}
