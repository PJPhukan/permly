// Smoke-tests every example against the packed tarball, i.e. exactly what npm would publish.
//
//   npm run examples:test
//   EXAMPLES_DATABASE_URL=mysql://root:permly@127.0.0.1:33061/permly npm run examples:test
//
// Each example is copied to a temp dir, gets the tarball installed as "permly", is built if it
// has a build script, started on a random port, and checked with real HTTP requests.
// With EXAMPLES_DATABASE_URL, each example also runs once against MySQL.
//
// Then the CLI flow (scripts/cli-flow.mjs): fresh folders, npx permly init + migrate, sync(),
// can(). It uses EXAMPLES_DATABASE_URL, or the docker compose MySQL, and skips if neither is
// reachable (fails instead with PERMLY_REQUIRE_DB=1).
import { spawn, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testCliFlow } from "./cli-flow.mjs";

const root = resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const work = mkdtempSync(join(tmpdir(), "permly-examples-"));
const databaseUrl = process.env.EXAMPLES_DATABASE_URL;

// Windows needs a shell to run npm.cmd.
function run(cmd, args, cwd) {
  execFileSync(cmd, args, {
    cwd,
    shell: process.platform === "win32",
    stdio: ["ignore", "ignore", "inherit"],
  });
}

/** Starts the example's `npm start` command directly with node and waits for its URL. */
function start(dir, env) {
  const { scripts } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const [command, ...args] = scripts.start.split(" ");
  if (command !== "node") throw new Error(`Unexpected start script: ${scripts.start}`);
  const child = spawn(process.execPath, args, {
    cwd: dir,
    env: { ...process.env, PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  return new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => fail(new Error("server did not start in 20s")), 20_000);
    const fail = (err) => {
      clearTimeout(timer);
      child.kill();
      reject(new Error(`${err.message}\n--- output ---\n${output}`));
    };
    const onData = (chunk) => {
      output += chunk;
      const match = /listening on (http:\/\/localhost:\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolveUrl({ url: match[1], stop: () => child.kill(), output: () => output });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => fail(new Error(`server exited with code ${code}`)));
  });
}

/** The same checks for every example: they all implement the same posts API. */
async function check(url) {
  const call = async (method, path, user, body) => {
    const headers = { "content-type": "application/json" };
    if (user) headers["x-user-id"] = user;
    const res = await fetch(url + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const expectations = [
    ["GET", "/posts", undefined, 200],
    ["POST", "/posts", undefined, 401, { error: "Unauthorized" }],
    ["POST", "/posts", "4", 403, { error: "Forbidden", missing: ["posts.create"] }],
    ["POST", "/posts", "2", 201],
    ["PUT", "/posts/1", "2", 200],
    ["PUT", "/posts/1", "3", 403, { error: "Forbidden", missing: ["posts.edit"] }],
    ["PUT", "/posts/1", "1", 200],
    ["PUT", "/posts/999", "1", 404],
    ["DELETE", "/posts/1", "2", 403, { error: "Forbidden", missing: ["posts.delete"] }],
    ["DELETE", "/posts/1", "1", 204],
    ["GET", "/admin", "2", 403, { error: "Forbidden", missing: ["admin"] }],
    ["GET", "/admin", "1", 200],
  ];
  for (const [method, path, user, status, body] of expectations) {
    const res = await call(method, path, user, method === "GET" ? undefined : { title: "x" });
    const label = `${method} ${path} as ${user ?? "nobody"}`;
    if (res.status !== status) throw new Error(`${label}: expected ${status}, got ${res.status}`);
    if (body && JSON.stringify(res.body) !== JSON.stringify(body)) {
      throw new Error(
        `${label}: expected ${JSON.stringify(body)}, got ${JSON.stringify(res.body)}`,
      );
    }
  }
  return expectations.length;
}

let failed = false;
try {
  const [{ filename }] = JSON.parse(
    execFileSync(npm, ["pack", "--json", "--pack-destination", work], {
      cwd: root,
      shell: process.platform === "win32",
    }),
  );
  const tarball = join(work, filename);
  console.log(`Packed ${filename}`);

  const examples = readdirSync(join(root, "examples"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const name of examples) {
    const dir = join(work, name);
    cpSync(join(root, "examples", name), dir, {
      recursive: true,
      filter: (src) => !/[/\\](node_modules|dist)$/.test(src),
    });
    const pkgPath = join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.dependencies.permly = `file:${tarball}`;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    run(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error"], dir);
    if (pkg.scripts.build) run(npm, ["run", "build"], dir);

    const modes = databaseUrl
      ? [
          ["memory", {}],
          ["mysql", { DATABASE_URL: databaseUrl }],
        ]
      : [["memory", {}]];
    for (const [mode, env] of modes) {
      const server = await start(dir, env);
      try {
        const count = await check(server.url);
        console.log(`✓ ${name} (${mode}): ${count} requests as expected`);
      } catch (err) {
        failed = true;
        console.error(
          `✗ ${name} (${mode}): ${err.message}\n--- server output ---\n${server.output()}`,
        );
      } finally {
        server.stop();
      }
    }
  }

  const cliOk = await testCliFlow({
    tarball,
    work,
    databaseUrl: databaseUrl ?? "mysql://root:permly@127.0.0.1:33061/permly",
  });
  if (!cliOk) failed = true;
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
