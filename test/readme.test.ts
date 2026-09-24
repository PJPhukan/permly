/**
 * Every ```js and ```ts example in README.md, proven to work:
 * - JavaScript examples run in Node against the built package. A line ending in `// true`,
 *   `// false` or `// → <json>` becomes an assertion.
 * - TypeScript examples are type-checked (strict, NodeNext), including their @ts-expect-error.
 * - `./permly.js` is the file `npx permly init` generates, here with the memory adapter.
 * - `<!-- test: mysql | postgres | mongodb | mongoose -->` before a block runs it against that
 *   database (tables created with `permly migrate`); `<!-- test: skip ... -->` skips it.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MongoClient } from "mongodb";
import mysql from "mysql2/promise";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectOrSkip } from "./adapters/db";

const ROOT = resolve(import.meta.dirname, "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");

type Tag = "memory" | "skip" | "mysql" | "postgres" | "mongodb" | "mongoose";

interface Block {
  lang: "js" | "ts";
  code: string;
  line: number;
  tag: Tag;
}

function extractBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.split("\n");
  let tag: Tag | undefined;
  for (let i = 0; i < lines.length; i++) {
    const annotation = /^<!-- test: (\w+)/.exec(lines[i] ?? "");
    if (annotation) {
      tag = annotation[1] as Tag;
      continue;
    }
    const fence = /^```(\w+)\s*$/.exec(lines[i] ?? "");
    if (!fence) continue;
    const start = i;
    const body: string[] = [];
    for (i++; i < lines.length && lines[i] !== "```"; i++) body.push(lines[i] ?? "");
    const lang = fence[1];
    if (lang === "js" || lang === "ts") {
      blocks.push({ lang, code: body.join("\n"), line: start + 1, tag: tag ?? "memory" });
    }
    tag = undefined;
  }
  return blocks;
}

/** `expr; // true` and `expr; // → json` become assertions. */
function withAssertions(code: string, line: number): string {
  return code
    .split("\n")
    .map((text, offset) => {
      const match = /^(\s*)(.+?);\s*\/\/ (?:(true|false)\b.*|→ (.+))$/.exec(text);
      if (!match) return text;
      const [, indent = "", expression = "", bool, json] = match;
      if (/^(const|let|var|return|if|import|export)\b/.test(expression)) return text;
      const expected = bool ?? json ?? "";
      return `${indent}__expect((${expression}), ${expected}, ${line + 1 + offset});`;
    })
    .join("\n");
}

const EXPECT = `const __expect = (actual, expected, line) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("README line " + line + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
};
`;

// The file `npx permly init` generates, with the memory adapter instead of a database.
const PERMLY_JS = `import { createPermissions } from "permly";
import { memoryAdapter } from "permly/memory";

export const perms = createPermissions({
  adapter: memoryAdapter(),
  permissions: ["posts.create", "posts.edit", "posts.edit.own", "posts.delete"],
  roles: ["admin", "editor", "viewer"],
});

export async function setupPermissions() {
  const { createdRoles } = await perms.sync();
  if (createdRoles.includes("admin")) await perms.role("admin").givePermission("*");
  if (createdRoles.includes("editor")) {
    await perms.role("editor").givePermission("posts.create", "posts.edit.own");
  }
}
`;
const PERMLY_TS = PERMLY_JS.replace(
  "export async function setupPermissions() {",
  "export async function setupPermissions(): Promise<void> {",
);

// Examples may call app.listen(3000): listen on a random free port instead, without keeping
// the process alive.
const PRELOAD = `import http from "node:http";
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  const callback = args.find((arg) => typeof arg === "function");
  return listen.call(this, 0, callback).unref();
};
`;

const DATABASES: Record<"mysql" | "postgres" | "mongodb", { url: string; envVar: string }> = {
  mysql: {
    url: process.env.PERMLY_MYSQL_URL ?? "mysql://root:permly@127.0.0.1:33061/permly",
    envVar: "PERMLY_MYSQL_URL",
  },
  postgres: {
    url: process.env.PERMLY_PG13_URL ?? "postgres://postgres:permly@127.0.0.1:54313/permly",
    envVar: "PERMLY_PG13_URL",
  },
  mongodb: {
    url: process.env.PERMLY_MONGO7_URL ?? "mongodb://127.0.0.1:27107/permly",
    envVar: "PERMLY_MONGO7_URL",
  },
};

const TABLES = ["user_permissions", "user_roles", "role_permissions", "permissions", "roles"];

async function dropPermTables(db: keyof typeof DATABASES, url: string) {
  if (db === "mysql") {
    const connection = await mysql.createConnection(url);
    for (const table of TABLES) await connection.query(`DROP TABLE IF EXISTS \`perm_${table}\``);
    await connection.end();
  } else if (db === "postgres") {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    for (const table of TABLES) await client.query(`DROP TABLE IF EXISTS "perm_${table}"`);
    await client.end();
  } else {
    const client = await new MongoClient(url).connect();
    for (const name of [...TABLES, "locks"]) {
      await client
        .db()
        .collection(`perm_${name}`)
        .drop()
        .catch(() => {});
    }
    await client.close();
  }
}

async function ping(db: keyof typeof DATABASES, url: string): Promise<string> {
  if (db === "mysql") {
    const connection = await mysql.createConnection({ uri: url, connectTimeout: 3000 });
    await connection.end();
  } else if (db === "postgres") {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    await client.connect();
    await client.end();
  } else {
    const client = await new MongoClient(url, { serverSelectionTimeoutMS: 3000 }).connect();
    await client.close();
  }
  return url;
}

const blocks = extractBlocks(README);
const reachable: Partial<Record<keyof typeof DATABASES, string>> = {};
for (const db of Object.keys(DATABASES) as (keyof typeof DATABASES)[]) {
  const url = await connectOrSkip(`${db} (README examples)`, DATABASES[db].envVar, () =>
    ping(db, DATABASES[db].url),
  );
  if (url) reachable[db] = url;
}

let dir: string;
let typeErrors: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "permly-readme-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "readme", type: "module" }));
  mkdirSync(join(dir, "node_modules"));
  const link = (name: string, target: string) =>
    symlinkSync(target, join(dir, "node_modules", name), "junction");
  link("permly", ROOT);
  link("express", join(ROOT, "node_modules/express5"));
  link("@types", join(ROOT, "node_modules/@types"));
  for (const name of ["jsonwebtoken", "mysql2", "pg", "mongodb", "mongoose"]) {
    link(name, join(ROOT, "node_modules", name));
  }
  writeFileSync(join(dir, "permly.js"), PERMLY_JS);
  writeFileSync(join(dir, "permly.ts"), PERMLY_TS);
  writeFileSync(join(dir, "preload.mjs"), PRELOAD);
  writeFileSync(
    join(dir, "run.mjs"),
    `import { pathToFileURL } from "node:url";
await import(pathToFileURL(process.argv[2]).href);
process.exit(0); // pools and servers would otherwise keep running`,
  );

  // Database examples need the tables: create them with the real CLI.
  for (const [db, url] of Object.entries(reachable)) {
    const result = spawnSync(
      process.execPath,
      [join(ROOT, "dist/cli.js"), "migrate", "--yes", "--url", url],
      { cwd: dir, encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(`migrate ${db} failed:\n${result.stderr}`);
  }

  // Type-check all TypeScript examples in one tsc run.
  const tsFiles = blocks.flatMap((block, i) => {
    if (block.lang !== "ts" || block.tag === "skip") return [];
    writeFileSync(join(dir, `example-${i}.ts`), block.code);
    return [`example-${i}.ts`];
  });
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ["node"],
      },
      files: ["permly.ts", ...tsFiles],
    }),
  );
  const tsc = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", "."],
    {
      cwd: dir,
      encoding: "utf8",
    },
  );
  typeErrors = tsc.stdout + tsc.stderr;
}, 120_000);

afterAll(async () => {
  for (const [db, url] of Object.entries(reachable)) {
    await dropPermTables(db as keyof typeof DATABASES, url);
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("README examples", () => {
  it("has examples to test", () => {
    expect(blocks.filter((b) => b.lang === "js").length).toBeGreaterThan(20);
    expect(blocks.filter((b) => b.lang === "ts").length).toBeGreaterThan(20);
  });

  for (const [i, block] of blocks.entries()) {
    const title = `line ${block.line}: ${block.lang}${block.tag === "memory" ? "" : ` (${block.tag})`}`;
    if (block.tag === "skip") {
      it.skip(title, () => {});
      continue;
    }

    if (block.lang === "ts") {
      it(`${title} type-checks`, () => {
        const errors = typeErrors.split("\n").filter((text) => text.startsWith(`example-${i}.ts(`));
        expect(errors).toEqual([]);
      });
      continue;
    }

    const database = block.tag === "mongoose" ? "mongodb" : block.tag;
    const needsDb = database !== "memory";
    const url = needsDb ? reachable[database] : undefined;
    it.skipIf(needsDb && !url)(`${title} runs`, { timeout: 30_000 }, () => {
      const commonjs = /\brequire\(/.test(block.code);
      const file = `example-${i}.${commonjs ? "cjs" : "mjs"}`;
      writeFileSync(join(dir, file), EXPECT + withAssertions(block.code, block.line));
      const result = spawnSync(process.execPath, ["--import", "./preload.mjs", "run.mjs", file], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, ...(url ? { DATABASE_URL: url } : {}) },
      });
      expect(result.stderr, result.stdout).toBe("");
      expect(result.status).toBe(0);
    });
  }
});
