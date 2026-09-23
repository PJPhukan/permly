// The "new user" flow from the packed tarball, in fresh folders:
//   npm install permly mysql2  →  npx permly init  →  npx permly migrate  →  sync() and can().
// Used by examples-test.mjs. Needs a MySQL/MariaDB database.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import mysql from "mysql2/promise";

const isWindows = process.platform === "win32";
const npm = isWindows ? "npm.cmd" : "npm";
const npx = isWindows ? "npx.cmd" : "npx";

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

const CHECK = `
await setupPermissions();
await perms.user(1).assignRole("editor");
await perms.user(2).assignRole("admin");
const results = [
  await perms.user(1).can("posts.create"),
  !(await perms.user(1).can("posts.delete")),
  await perms.user(1).canOwn("posts.edit", 1),
  await perms.user(2).can("posts.delete"),
];
console.log(results.every(Boolean) ? "PERMLY_OK" : "PERMLY_FAIL " + JSON.stringify(results));
process.exit(0); // the starter's pool would otherwise keep the process alive
`;

const variants = [
  {
    name: "JavaScript ES modules",
    packageJson: { type: "module" },
    files: { "check.js": `import { perms, setupPermissions } from "./src/permly.js";\n${CHECK}` },
    run: ["check.js"],
  },
  {
    name: "JavaScript CommonJS",
    packageJson: {},
    files: {
      "check.js": `const { perms, setupPermissions } = require("./src/permly.js");\n(async () => {${CHECK}})();`,
    },
    run: ["check.js"],
  },
  {
    name: "TypeScript",
    packageJson: { type: "module" },
    devDependencies: ["typescript@~5.9", "@types/node@22"],
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
      "src/check.ts": `import { perms, setupPermissions } from "./permly.js";\n${CHECK}`,
    },
    // Also type-check the generated file with the older resolution modes users still have.
    typecheck: [
      ["--module", "commonjs", "--moduleResolution", "node10"],
      ["--module", "esnext", "--moduleResolution", "bundler"],
    ],
    build: true,
    run: ["dist/check.js"],
  },
];

async function reachable(url) {
  try {
    const connection = await mysql.createConnection({ uri: url, connectTimeout: 3000 });
    await connection.end();
    return true;
  } catch {
    return false;
  }
}

/** Returns false if the flow failed. */
export async function testCliFlow({ tarball, work, databaseUrl }) {
  if (!(await reachable(databaseUrl))) {
    const message = `CLI flow needs a MySQL database at EXAMPLES_DATABASE_URL (default: docker compose).`;
    if (process.env.PERMLY_REQUIRE_DB === "1") {
      console.error(`✗ ${message}`);
      return false;
    }
    console.log(`⚠ Skipping the CLI flow. ${message}`);
    return true;
  }

  let ok = true;
  for (const [i, variant] of variants.entries()) {
    const dir = join(work, `cli-${i}`);
    const prefix = `permly_smoke${i}_${Date.now() % 100000}_`;
    const env = { DATABASE_URL: databaseUrl };
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
      run(npm, ["install", ...quiet, tarball, "mysql2"], dir);
      if (variant.devDependencies)
        run(npm, ["install", ...quiet, "-D", ...variant.devDependencies], dir);

      run(npx, ["permly", "init", "--db", "mysql", "--prefix", prefix], dir);
      const migrated = run(npx, ["permly", "migrate", "--yes", "--prefix", prefix], dir, env);
      if (!migrated.includes(`created  ${prefix}roles`)) throw new Error(`migrate:\n${migrated}`);

      for (const flags of variant.typecheck ?? []) {
        run(
          npx,
          [
            "tsc",
            "--noEmit",
            "--strict",
            "--esModuleInterop",
            "--types",
            "node",
            ...flags,
            "src/permly.ts",
          ],
          dir,
        );
      }
      if (variant.build) run(npx, ["tsc"], dir);

      const output = run(process.execPath, variant.run, dir, env);
      if (!output.includes("PERMLY_OK")) throw new Error(output);
      console.log(`✓ CLI flow, ${variant.name}: init → migrate → sync() → can()`);
    } catch (error) {
      ok = false;
      const details = [error.message, error.stdout, error.stderr].filter(Boolean).join("\n");
      console.error(`✗ CLI flow, ${variant.name}:\n${details}`);
    } finally {
      await dropTables(databaseUrl, prefix);
    }
  }
  return ok;
}

async function dropTables(url, prefix) {
  const connection = await mysql.createConnection({ uri: url });
  try {
    for (const table of [
      "user_permissions",
      "user_roles",
      "role_permissions",
      "permissions",
      "roles",
    ]) {
      await connection.query(`DROP TABLE IF EXISTS \`${prefix}${table}\``);
    }
  } finally {
    await connection.end();
  }
}
