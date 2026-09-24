// Checks the packed tarball on the running Node.js version (CI runs it on 18, 20 and 22).
// The dev toolchain needs Node 22, so this is how the published package is tested on older
// versions. Only uses APIs available in Node 18.
//
//   node scripts/node-compat.mjs path/to/permly-x.y.z.tgz
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tarball = process.argv[2];
if (!tarball) {
  console.error("Usage: node scripts/node-compat.mjs <permly tarball>");
  process.exit(2);
}

const isWindows = process.platform === "win32";
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    shell: isWindows,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

// Shared by the CommonJS and ES module checks: core, wildcards, errors, Express.
const checks = (header) => `${header}
const assert = (ok, what) => { if (!ok) { throw new Error("FAILED: " + what); } };

async function main() {
  const perms = createPermissions({
    adapter: memoryAdapter(),
    permissions: ["posts.create", "posts.edit", "posts.edit.own", "posts.delete"],
    roles: ["admin", "editor"],
  });
  await perms.sync();
  await perms.role("admin").givePermission("posts.*");
  await perms.role("editor").givePermission("posts.create", "posts.edit.own");
  await perms.user(1).assignRole("editor");
  await perms.user(2).assignRole("admin");

  assert(await perms.user(1).can("posts.create"), "can");
  assert(!(await perms.user(1).can("posts.delete")), "cannot");
  assert(await perms.user(1).canOwn("posts.edit", 1), "canOwn own");
  assert(!(await perms.user(1).canOwn("posts.edit", 2)), "canOwn other");
  assert(await perms.user(2).can("posts.delete"), "wildcard");
  const error = await perms.user(1).authorize("posts.delete").catch((e) => e);
  assert(isPermissionDeniedError(error) && error.missing[0] === "posts.delete", "denied error");
  const typo = await perms.user(1).can("posts.edt").catch((e) => e);
  assert(/Did you mean "posts.edit"/.test(typo.message), "did you mean");

  for (const factory of [mysqlAdapter, postgresAdapter, mongodbAdapter]) {
    assert(typeof factory === "function", "adapter export");
  }

  const app = express();
  app.use((req, _res, next) => { req.user = { id: req.get("x-user-id") }; next(); });
  app.get("/delete", requirePermission(perms, "posts.delete"), (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const url = "http://127.0.0.1:" + server.address().port + "/delete";
  const denied = await fetch(url, { headers: { "x-user-id": "1" } });
  const allowed = await fetch(url, { headers: { "x-user-id": "2" } });
  server.close();
  assert(denied.status === 403 && allowed.status === 200, "express");
  console.log("ok");
}
main().catch((e) => { console.error(e); process.exit(1); });
`;

const cjs = checks(`const { createPermissions, isPermissionDeniedError } = require("permly");
const { memoryAdapter } = require("permly/memory");
const { mysqlAdapter } = require("permly/mysql");
const { postgresAdapter } = require("permly/postgres");
const { mongodbAdapter } = require("permly/mongodb");
const { requirePermission } = require("permly/express");
const express = require("express");`);

const esm = checks(`import { createPermissions, isPermissionDeniedError } from "permly";
import { memoryAdapter } from "permly/memory";
import { mysqlAdapter } from "permly/mysql";
import { postgresAdapter } from "permly/postgres";
import { mongodbAdapter } from "permly/mongodb";
import { requirePermission } from "permly/express";
import express from "express";`);

const dir = mkdtempSync(join(tmpdir(), "permly-compat-"));
try {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "compat", private: true }));
  run(
    isWindows ? "npm.cmd" : "npm",
    ["install", "--no-audit", "--no-fund", "--loglevel=error", resolve(tarball), "express@4"],
    dir,
  );
  writeFileSync(join(dir, "check.cjs"), cjs);
  writeFileSync(join(dir, "check.mjs"), esm);

  for (const file of ["check.cjs", "check.mjs"]) {
    const output = run(process.execPath, [file], dir).trim();
    if (output !== "ok") throw new Error(`${file}: ${output}`);
    console.log(`✓ ${file} (Node ${process.version})`);
  }

  const cli = join(dir, "node_modules", "permly", "dist", "cli.js");
  const version = run(process.execPath, [cli, "--version"], dir).trim();
  run(process.execPath, [cli, "init", "--db", "postgres"], dir);
  console.log(`✓ CLI ${version}: --version, init`);
} catch (error) {
  console.error(error.stdout || "", error.stderr || "", error.message);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
