# permly

Simple roles & permissions for Node.js. Zero dependencies.

> **Draft.** The full README (API reference, caching, FAQ) comes before the first release.
> This covers the core idea, Express and MySQL setup.

```sh
npm install permly
```

```js
import { createPermissions } from "permly";
import { memoryAdapter } from "permly/memory";

const perms = createPermissions({
  adapter: memoryAdapter(),
  permissions: ["posts.create", "posts.edit", "posts.edit.own", "posts.delete"],
  roles: ["admin", "editor"],
});

await perms.sync(); // creates the roles and permissions above if missing

await perms.role("editor").givePermission("posts.create", "posts.edit.own");
await perms.role("admin").givePermission("posts.*");
await perms.user(1).assignRole("editor");

await perms.user(1).can("posts.create"); // true
await perms.user(1).canOwn("posts.edit", post.userId); // true only for their own posts
```

## Express

Works with Express 4 and 5. `permly/express` has no dependencies and doesn't import Express.

```js
const express = require("express");
const { permlyExpress, requirePermission } = require("permly/express");

const app = express();
// ... your auth middleware sets req.user = { id } ...

// One-off: a single function per route.
app.delete("/posts/:id", requirePermission(perms, "posts.delete"), deletePost);

// Or create a guard once and reuse it (options apply to every route).
const guard = permlyExpress(perms);

app.post("/posts", guard.permission("posts.create"), createPost);
app.get("/reports", guard.anyPermission(["reports.view", "reports.export"]), listReports);
app.get("/admin", guard.role("admin"), adminPage);

// Ownership: allowed with "posts.edit", or with "posts.edit.own" on your own post.
app.put(
  "/posts/:id",
  guard.own("posts.edit", async (req) => (await db.getPost(req.params.id))?.userId),
  updatePost,
);
```

| Situation                                              | Response                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| No user                                                | `401 { "error": "Unauthorized" }`                           |
| Missing permission or role                             | `403 { "error": "Forbidden", "missing": ["posts.delete"] }` |
| `own()` loader returns `null`/`undefined`              | `404 { "error": "Not Found" }`                              |
| Anything else (database down, unknown permission name) | passed to `next(err)`, i.e. your error handler              |

All guards: `permission`, `anyPermission`, `allPermissions`, `role`, `anyRole`, `allRoles`,
`own`. The simple functions are `requirePermission`, `requireAnyPermission`,
`requireAllPermissions`, `requireRole`, `requireAnyRole` and `requireAllRoles`; each takes the
same options as a third argument.

### Options

```js
const guard = permlyExpress(perms, {
  // Default: req.user?.id. May be async.
  getUserId: (req) => req.session.userId,

  onUnauthenticated: (req, res) => res.status(401).json({ error: "Please log in" }),

  // `missing` lists permissions (or roles, for role guards). Hide it if you prefer.
  onDenied: (req, res, missing) => res.status(403).json({ error: "Forbidden" }),

  onNotFound: (req, res) => res.status(404).json({ error: "Post not found" }),
});
```

### TypeScript

Permission and role names autocomplete, and typos don't compile:

```ts
import express, { type Request } from "express";
import { permlyExpress, requireRole } from "permly/express";

const perms = createPermissions({
  adapter,
  permissions: ["posts.create", "posts.edit", "posts.edit.own"],
  roles: ["admin", "editor"],
});

// Assumes your auth types req.user (see examples/express-ts for the declaration).
const guard = permlyExpress(perms, { getUserId: (req: Request) => req.user?.id });

app.post("/posts", guard.permission("posts.create"), createPost);
app.get("/admin", requireRole(perms, "admin"), adminPage);

guard.permission("posts.crate"); // ✗ compile error
```

Loaders and callbacks get your request type when you annotate `getUserId`, and a loose
`req` otherwise.

See [`examples/`](./examples) for complete apps in CommonJS, ES modules and TypeScript.

## MySQL / MariaDB

Tested on MySQL 8.4 and MariaDB 11. Uses [`mysql2`](https://www.npmjs.com/package/mysql2),
which you install yourself:

```sh
npm install permly mysql2
```

### 1. Create the tables

The tables are prefixed with `perm_` by default. Run the schema once, e.g. in a migration:

```js
import { mysqlSchema } from "permly/mysql";

console.log(mysqlSchema()); // or mysqlSchema("myapp_perm_") for a custom prefix
```

It creates `perm_roles`, `perm_permissions`, `perm_role_permissions`, `perm_user_roles` and
`perm_user_permissions`. Statements use `CREATE TABLE IF NOT EXISTS`, so re-running is safe.
`mysqlSchemaStatements()` returns the same SQL as an array, one statement each, if your
connection doesn't allow multiple statements.

permly never adds a foreign key to your users table. User ids are stored as strings (up to 64
characters), so integer ids, UUIDs and ObjectIds all work.

### 2. Connect

```js
import mysql from "mysql2/promise";
import { createPermissions } from "permly";
import { mysqlAdapter } from "permly/mysql";

const pool = mysql.createPool(process.env.DATABASE_URL);

const perms = createPermissions({
  adapter: mysqlAdapter(pool), // or mysqlAdapter(pool, { prefix: "myapp_perm_" })
  permissions: ["posts.create", "posts.edit", "posts.delete"],
  roles: ["admin", "editor"],
});

await perms.sync();
```

Pass a **pool** from `mysql2/promise`. If you already use the callback API
(`require("mysql2").createPool()`), pass `pool.promise()`.

### Notes

- Role names, permission names and user ids are **case-sensitive** (`utf8mb4_bin`).
- `syncRoles()` and `syncPermissions()` run in a transaction and are safe to call concurrently.
  `syncRoles()` uses a named lock (`GET_LOCK`) per user, which Galera clusters don't support.
  If another `syncRoles()` for the same user holds it for more than 10 seconds, it throws a
  `PermissionsError` with `code: "LOCK_TIMEOUT"`.
- A user's roles and permissions are loaded in a single indexed query and cached in memory for
  60 seconds (`cache: { ttl }`). The cache is per process: on several servers, a change made on
  one server shows up on the others after the TTL.
