# permly

Simple roles & permissions for Node.js. Zero dependencies.

> **Draft.** The full README (API reference, caching, FAQ) comes before the first release.

## Quick start (MySQL, MariaDB or Postgres)

```sh
npm install permly mysql2   # or: npm install permly pg
npx permly init
```

`init` asks a few questions (database, table prefix, migrations folder, and the schema for
Postgres), detects TypeScript and ES modules vs CommonJS, and creates:

- `migrations/<timestamp>_permly_init.sql`, the tables (safe to run more than once)
- `src/permly.js` (or `.ts`), your permissions setup, ready to import

Create the tables, then use it:

```sh
DATABASE_URL=mysql://user:password@localhost:3306/mydb npx permly migrate
# or DATABASE_URL=postgres://user:password@localhost:5432/mydb npx permly migrate
```

```js
import { perms, setupPermissions } from "./src/permly.js";

// Once at startup. Creates missing roles/permissions; the default grants in the file are
// only applied the first time, so permission changes made later survive restarts.
await setupPermissions();

await perms.user(1).assignRole("editor");
await perms.user(1).can("posts.create"); // true
await perms.user(1).can("posts.delete"); // false
await perms.user(1).canOwn("posts.edit", post.userId); // true only for their own posts
```

Edit the roles and permissions in `src/permly.js` to fit your app.

### CLI reference

```text
npx permly init       Create the SQL file and the starter src/permly.(js|ts)
npx permly migrate    Create the tables in DATABASE_URL (never changes existing tables)

--db mysql|postgres   Database (mongodb coming soon)
--prefix <prefix>     Table prefix, default perm_
--schema <name>       Postgres schema, default public (must already exist)
--out <dir>           init: folder for the SQL file, default migrations
--ts / --js           init: starter file language (default: detected)
--esm / --cjs         init: module format for JavaScript (default: detected)
--force               init: overwrite existing files (otherwise it asks, or refuses in CI)
--url <url>           migrate: database URL instead of DATABASE_URL
--yes                 migrate: skip the confirmation
```

In CI (no terminal) nothing is ever prompted: use `npx permly init --db mysql` (or
`--db postgres`) and `npx permly migrate --yes`. `migrate` accepts `mysql://`, `mariadb://`,
`postgres://` and `postgresql://` URLs, shows the target database but never prints the
password, and uses the driver installed in your project (`mysql2` or `pg`).

> **Using Prisma?** Don't run permly's SQL alongside `prisma migrate`: Prisma sees tables it
> doesn't manage as drift and may offer to reset the database. Proper Prisma support comes
> later; until then, keep permly's tables in a database Prisma doesn't migrate.

### Without a database

For tests and prototypes, the in-memory adapter needs no setup:

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

The easiest way is `npx permly migrate` (see Quick start). To run the SQL yourself, e.g. with
your own migration tool, use the file `permly init` generated, or get it from code:

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

## Postgres

Tested on Postgres 13 and 17. Uses [`pg`](https://www.npmjs.com/package/pg), which you install
yourself:

```sh
npm install permly pg
```

### 1. Create the tables

`npx permly migrate` with a `postgres://` or `postgresql://` URL (see Quick start), or run the
SQL yourself from the file `permly init` generated, or from code:

```js
import { postgresSchema, postgresSchemaStatements } from "permly/postgres";

console.log(postgresSchema()); // or postgresSchema("myapp_perm_", "auth")
```

The tables use `INT GENERATED ALWAYS AS IDENTITY` ids, foreign keys with `ON DELETE CASCADE`,
and ordinary (case-sensitive) text columns. permly never adds a foreign key to your users
table.

### 2. Connect

```js
import pg from "pg";
import { createPermissions } from "permly";
import { postgresAdapter } from "permly/postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const perms = createPermissions({
  adapter: postgresAdapter(pool), // or postgresAdapter(pool, { prefix: "app_", schema: "auth" })
  permissions: ["posts.create", "posts.edit", "posts.delete"],
  roles: ["admin", "editor"],
});

await perms.sync();
```

Pass a `pg` **Pool**, not a single `Client`: transactions need their own connection from the
pool. Any pg-compatible pool works, e.g. `@neondatabase/serverless`.

### Schema option

By default the tables live in `public`. With `schema: "auth"` (and `npx permly migrate
--schema auth`) they live in `auth` instead. The schema must already exist
(`CREATE SCHEMA auth;`); permly doesn't create it.

permly always writes schema-qualified, quoted names (`"auth"."perm_roles"`), so it never
depends on the connection's `search_path`. Because the name is quoted it is case-sensitive:
`schema: "Auth"` and `schema: "auth"` are different schemas.

### PgBouncer and serverless poolers

permly works behind PgBouncer in **transaction mode** (Supabase's pooler on port 6543, Neon's
pooled connection string, RDS Proxy): it only sends unnamed statements (no named prepared
statements), and its locks and settings are transaction-scoped (`pg_advisory_xact_lock`,
`SET LOCAL`), so nothing leaks to the next client on the same server connection.

Run `npx permly migrate` against the direct (non-pooled) connection string if your provider
recommends that for schema changes.

### SSL (Supabase, Neon, RDS, ...)

SSL is handled by `pg`, so configure it the usual way: `?sslmode=require` in the URL, or
`new pg.Pool({ connectionString, ssl: { ca } })` with your provider's CA certificate. If the
server uses a certificate your machine doesn't trust and you accept that risk,
`?sslmode=no-verify` encrypts without verifying. The same URL works for `npx permly migrate`.

### Notes

- `syncRoles()` takes a transaction-level advisory lock per user and `syncPermissions()`
  locks the role's row, so concurrent calls are safe and never leave a mix of two lists.
  Waiting for a lock gives up after 10 seconds with a `PermissionsError` (`code:
"LOCK_TIMEOUT"`). Deadlocks and serialization failures are retried once.
- Lists of any size are sent as one array parameter (`= ANY($1::text[])`).
- If the tables or the schema are missing, errors say so and show the `npx permly migrate`
  command to fix it.
- TypeScript: the generated `src/permly.ts` uses `import pg from "pg"`, which needs
  `esModuleInterop` (on by default in new projects) unless you use `"module": "NodeNext"`.
