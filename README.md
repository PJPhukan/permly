<h1 align="center">permly</h1>

<p align="center">
  <strong>Simple, type-safe roles &amp; permissions for Node.js. Works with MySQL, Postgres and MongoDB.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/permly"><img src="https://img.shields.io/npm/v/permly?color=cb3837&amp;logo=npm" alt="npm version"></a>
  <a href="https://github.com/PJPhukan/permly/actions/workflows/ci.yml"><img src="https://github.com/PJPhukan/permly/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/PJPhukan/permly/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <a href="https://www.npmjs.com/package/permly"><img src="https://img.shields.io/npm/dm/permly" alt="npm downloads"></a>
  <a href="https://bundlephobia.com/package/permly"><img src="https://img.shields.io/bundlephobia/minzip/permly" alt="bundle size"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-ready-3178c6?logo=typescript&amp;logoColor=white" alt="TypeScript ready"></a>
</p>

permly adds **roles and permissions** to your Node.js app. Users get roles like `editor`, roles
get permissions like `posts.create`, and you check them with one line. It is for developers
who want access control that works in minutes: run one command, and permly sets up the tables
and a ready-to-use file for your database.

<!-- test: memory (the "at a glance" example) -->

```js
// npx permly init  → creates src/permly.js with your roles and permissions
import express from "express";
import { requirePermission } from "permly/express";
import { perms, setupPermissions } from "./permly.js";

await setupPermissions();
await perms.user(1).assignRole("editor");
await perms.user(1).can("posts.create"); // true

const app = express();
app.post("/posts", requirePermission(perms, "posts.create"), (req, res) => res.json({ ok: true }));
```

<details>
<summary>TypeScript</summary>

```ts
import express from "express";
import { requirePermission } from "permly/express";
import { perms, setupPermissions } from "./permly.js";

await setupPermissions();
await perms.user(1).assignRole("editor");
const allowed: boolean = await perms.user(1).can("posts.create");

const app = express();
app.post("/posts", requirePermission(perms, "posts.create"), (_req, res) => {
  res.json({ ok: true });
});
```

</details>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#core-concepts">Docs</a> ·
  <a href="https://github.com/PJPhukan/permly/tree/main/examples">Examples</a> ·
  <a href="#faq-and-troubleshooting">FAQ</a> ·
  <a href="https://github.com/sponsors/PJPhukan">Sponsor</a>
</p>

## Features

- **Zero runtime dependencies.** Small, and nothing extra to install or audit.
- **TypeScript autocomplete for your own names.** A typo like `"posts.edt"` is a compile error.
- **Your database:** MySQL, MariaDB, Postgres and MongoDB (plus an in-memory adapter for tests).
- **Express middleware** that answers 401, 403 and 404 for you.
- **Setup with one command:** `npx permly init` and `npx permly migrate`.
- **Built-in cache**, so checks are fast.
- **Wildcards:** `posts.*` for all post permissions, `*` for everything.
- **Ownership checks:** "editors may edit only their own posts" in one line.
- **Safe under concurrency:** parallel changes never leave mixed or duplicate data.
- **Works with plain JavaScript** too: `import` or `require`, no build step needed.

## Contents

- [Why permly?](#why-permly)
- [Comparison](#comparison)
- [Install](#install)
- [Quick start](#quick-start)
- [Core concepts](#core-concepts)
- [Express](#express)
- [Databases](#databases): [MySQL / MariaDB](#mysql--mariadb) · [Postgres](#postgres) ·
  [MongoDB](#mongodb)
- [Guides](#guides)
- [API reference](#api-reference)
- [FAQ and troubleshooting](#faq-and-troubleshooting)
- [Coming from Laravel (spatie/laravel-permission)](#coming-from-laravel-spatielaravel-permission)
- [Support permly](#support-permly) · [Contributing](#contributing) · [Security](#security) ·
  [License](#license)

## Why permly?

Most apps start with `if (user.isAdmin)`. Later come editors, then "editors may edit only
their own posts", then one customer who needs one extra permission. The checks end up in many
places, and they don't always agree. permly gives you one clear model instead:

- **Roles and permissions live in your database.** Users get roles, roles get permissions, and
  a user can also get one extra permission directly.
- **Checks are one line:** `can`, `hasRole`, and `canOwn` for "only your own".
- **Mistakes show up early.** An unknown name throws
  `Permission "posts.edt" does not exist. Did you mean "posts.edit"?`
- **It stays out of your way.** permly never changes your users table and adds no foreign keys
  to it.

## Comparison

Different tools solve different problems. This table helps you pick the right one.

|                                      | permly                                         | By hand                | [CASL](https://casl.js.org)                        | [Casbin](https://casbin.org)               |
| ------------------------------------ | ---------------------------------------------- | ---------------------- | -------------------------------------------------- | ------------------------------------------ |
| **Model**                            | Roles and permissions (RBAC)                   | Whatever you build     | Rules on subjects and fields (ABAC)                | Configurable models (ACL, RBAC, ABAC, ...) |
| **Setup time**                       | Minutes (`npx permly init`)                    | Days, then maintenance | Minutes to define rules in code                    | Write a model file, then pick an adapter   |
| **Database tables included**         | Yes: MySQL, Postgres, MongoDB                  | You design them        | No, rules live in code (storing them is up to you) | Yes, through adapters (a policy table)     |
| **CLI for setup**                    | Yes                                            | No                     | No                                                 | No                                         |
| **TypeScript autocomplete of names** | Yes, from your config                          | If you build it        | Yes, for typed actions and subjects                | No, policies are strings                   |
| **Express middleware**               | Included                                       | You write it           | You write a small one                              | Yes (`express-authz`)                      |
| **Learning curve**                   | Low                                            | Low at first           | Medium                                             | Medium (its model language)                |
| **Best for**                         | Classic roles and permissions in a Node.js app | Very small apps        | Fine-grained rules shared by frontend and backend  | Complex or custom policies, many languages |

## Install

Install permly, and the driver for your database.

```sh
npm install permly
# or: yarn add permly / pnpm add permly
```

Then add the driver for your database (skip this for the in-memory adapter):

```sh
npm install mysql2     # MySQL or MariaDB
npm install pg         # Postgres
npm install mongodb    # MongoDB (or use mongoose, if your app already does)
```

permly works with `import` and `require`, in JavaScript and TypeScript, on Node.js 18+. Node.js
22 or 24 is recommended: 18 and 20 are end-of-life, though permly is still tested on them.

## Quick start

This section takes you from an empty project to your first permission check.

<p align="center">
  <img src="https://raw.githubusercontent.com/PJPhukan/permly/main/.github/assets/demo.svg" alt="Terminal recording: npx permly init creates src/permly.js and a migration file, then npx permly migrate creates the tables" width="820">
</p>

**1. Generate the setup** (asks a few questions, detects TypeScript and ES modules):

```sh
npx permly init
```

This creates two files:

- `src/permly.js` (or `.ts`): your roles and permissions, ready to import.
- `migrations/<timestamp>_permly_init.sql`: the tables (a `.mjs` script for MongoDB).

**2. Create the tables** in your database:

```sh
DATABASE_URL=mysql://user:password@localhost:3306/mydb npx permly migrate
```

(Or run the generated SQL file with your own migration tool.)

**3. Use it.** Call `setupPermissions()` once at startup, then check anywhere:

```js
import { perms, setupPermissions } from "./permly.js";

await setupPermissions(); // creates the roles and permissions, grants the defaults once

await perms.user(1).assignRole("editor");

await perms.user(1).can("posts.create"); // true
await perms.user(1).can("posts.delete"); // false
await perms.user(1).canOwn("posts.edit", 1); // true (it's their own post)
await perms.user(1).canOwn("posts.edit", 2); // false
```

<details>
<summary>TypeScript</summary>

```ts
import { perms, setupPermissions } from "./permly.js";

await setupPermissions(); // creates the roles and permissions, grants the defaults once

await perms.user(1).assignRole("editor");

const allowed: boolean = await perms.user(1).can("posts.create");
// @ts-expect-error: typos are compile errors
await perms.user(1).can("posts.crate");
```

</details>

The generated `permly.js` looks like this (edit the lists to fit your app):

<!-- test: skip (shown for reading; the generated file itself is tested by the CLI tests) -->

```js
import { createPool } from "mysql2/promise";
import { createPermissions } from "permly";
import { mysqlAdapter } from "permly/mysql";

export const perms = createPermissions({
  adapter: mysqlAdapter(createPool(process.env.DATABASE_URL)),
  permissions: ["posts.create", "posts.edit", "posts.edit.own", "posts.delete"],
  roles: ["admin", "editor", "viewer"],
});

export async function setupPermissions() {
  const { createdRoles } = await perms.sync();
  // Defaults are granted only when a role is first created, so later changes survive restarts.
  if (createdRoles.includes("admin")) await perms.role("admin").givePermission("*");
  if (createdRoles.includes("editor")) {
    await perms.role("editor").givePermission("posts.create", "posts.edit.own");
  }
}
```

No database yet? Use the in-memory adapter: perfect for trying permly, prototypes and tests.

```js
import { createPermissions } from "permly";
import { memoryAdapter } from "permly/memory";

const perms = createPermissions({
  adapter: memoryAdapter(),
  permissions: ["posts.create", "posts.edit"],
  roles: ["editor"],
});

await perms.sync();
await perms.role("editor").givePermission("posts.create");
await perms.user("alice").assignRole("editor");
await perms.user("alice").can("posts.create"); // true
```

<details>
<summary>TypeScript</summary>

```ts
import { createPermissions } from "permly";
import { memoryAdapter } from "permly/memory";

const perms = createPermissions({
  adapter: memoryAdapter(),
  permissions: ["posts.create", "posts.edit"],
  roles: ["editor"],
});

await perms.sync();
await perms.role("editor").givePermission("posts.create");
await perms.user("alice").assignRole("editor");
const allowed: boolean = await perms.user("alice").can("posts.create");
```

</details>

## Core concepts

The examples below import `perms` from the file `npx permly init` generated, with these lists:

- Permissions: `posts.create`, `posts.edit`, `posts.edit.own`, `posts.delete`
- Roles: `admin`, `editor`, `viewer`

### Permissions and roles

A **permission** is something a user may do, named like `posts.edit` (letters, numbers, `_` and
`-`, separated by dots). A **role** is a named group of permissions, like `editor`.

List them in `createPermissions()` and call `sync()` at startup: it creates the missing ones and
never deletes anything, so it's safe on every start. Then give roles their permissions:

```js
import { perms } from "./permly.js";

await perms.sync();

await perms.role("editor").givePermission("posts.create", "posts.edit");
await perms.role("editor").revokePermission("posts.edit");
await perms.role("viewer").syncPermissions([]); // replace the whole list

await perms.role("editor").getPermissions(); // → ["posts.create"]
```

<details>
<summary>TypeScript</summary>

```ts
import { perms } from "./permly.js";

await perms.sync();

await perms.role("editor").givePermission("posts.create", "posts.edit");
await perms.role("editor").revokePermission("posts.edit");
await perms.role("viewer").syncPermissions([]);

const list: string[] = await perms.role("editor").getPermissions();
```

</details>

Grants are stored in the database, so they survive restarts. Create or delete roles and
permissions at runtime with `perms.createRole()`, `perms.createPermission()`,
`perms.deleteRole()` and `perms.deletePermission()`; deleting removes it from every user and
role too.

### Users

User ids can be numbers or strings (integer ids, UUIDs, MongoDB ObjectIds). `1` and `"1"` are
the same user. permly never touches your users table.

```js
import { perms } from "./permly.js";

await perms.sync();

await perms.user(42).assignRole("editor", "viewer"); // several at once
await perms.user(42).removeRole("viewer");
await perms.user(42).syncRoles(["editor"]); // replace all roles
await perms.user(42).getRoles(); // → ["editor"]

// A permission for this one user, on top of their roles:
await perms.user(42).givePermission("posts.delete");
await perms.user(42).revokePermission("posts.delete");
```

<details>
<summary>TypeScript</summary>

```ts
import { perms } from "./permly.js";

await perms.sync();

await perms.user(42).assignRole("editor", "viewer");
await perms.user(42).removeRole("viewer");
await perms.user(42).syncRoles(["editor"]);
const roles: string[] = await perms.user(42).getRoles();

await perms.user(42).givePermission("posts.delete");
await perms.user(42).revokePermission("posts.delete");
```

</details>

### Checks

Use checks to decide what a user may do. Each one returns `true` or `false`, except `authorize()`, which throws.

```js
import { perms, setupPermissions } from "./permly.js";

await setupPermissions(); // editor: posts.create, posts.edit.own
await perms.user(1).assignRole("editor");
const user = perms.user(1);

await user.can("posts.create"); // true
await user.canAny(["posts.delete", "posts.create"]); // true
await user.canAll(["posts.delete", "posts.create"]); // false
await user.hasRole("editor"); // true
await user.hasAnyRole(["admin", "viewer"]); // false
await user.hasAllRoles(["editor"]); // true
await user.getPermissions(); // → ["posts.create","posts.edit.own"]

// authorize() throws PermissionDeniedError instead of returning false:
await user.authorize("posts.create"); // passes silently
```

<details>
<summary>TypeScript</summary>

```ts
import { perms, setupPermissions } from "./permly.js";

await setupPermissions();
await perms.user(1).assignRole("editor");
const user = perms.user(1);

const canCreate: boolean = await user.can("posts.create");
const canEither: boolean = await user.canAny(["posts.delete", "posts.create"]);
const isEditor: boolean = await user.hasRole("editor");
const permissions: string[] = await user.getPermissions();
await user.authorize("posts.create");
```

</details>

### Only your own: `canOwn`

A common rule: editors may edit **their own** posts, admins may edit **any** post. Give editors
`posts.edit.own` and admins `posts.edit`, then:

```js
import { perms, setupPermissions } from "./permly.js";

await setupPermissions(); // editor has posts.edit.own, admin has "*"
await perms.user(1).assignRole("editor");
await perms.user(9).assignRole("admin");

const post = { id: 7, userId: 1 };

await perms.user(1).canOwn("posts.edit", post.userId); // true
await perms.user(2).canOwn("posts.edit", post.userId); // false
await perms.user(9).canOwn("posts.edit", post.userId); // true
```

<details>
<summary>TypeScript</summary>

```ts
import { perms, setupPermissions } from "./permly.js";

await setupPermissions();
await perms.user(1).assignRole("editor");

const post = { id: 7, userId: 1 };
const allowed: boolean = await perms.user(1).canOwn("posts.edit", post.userId);
```

</details>

`canOwn(p, ownerId)` is true when the user has `p`, or has `p + ".own"` and `ownerId` is their
id. A missing owner (`null` / `undefined`) never matches.

### Wildcards

`posts.*` grants every permission that starts with `posts.`, and `*` grants everything.
Wildcards are granted like normal permissions (they're created automatically), but you always
check a concrete name:

```js
import { perms } from "./permly.js";

await perms.sync();
await perms.role("admin").givePermission("*");
await perms.user(5).givePermission("posts.*");

await perms.user(5).can("posts.delete"); // true
await perms.user(5).getPermissions(); // → ["posts.*"]
await perms.user(5).getPermissions({ expand: true }); // → ["posts.create","posts.delete","posts.edit","posts.edit.own"]
```

<details>
<summary>TypeScript</summary>

```ts
import { perms } from "./permly.js";

await perms.sync();
await perms.role("admin").givePermission("*");
await perms.user(5).givePermission("posts.*", "posts.edit.*"); // autocompleted too
const expanded: string[] = await perms.user(5).getPermissions({ expand: true });
```

</details>

### Strict mode

By default (`strict: true`), using a name that doesn't exist throws, so a typo can't silently
change who gets access:

```js
import { perms } from "./permly.js";

await perms.sync();
try {
  await perms.user(1).can("posts.edt");
} catch (error) {
  error.message; // → "Permission \"posts.edt\" does not exist. Did you mean \"posts.edit\"?"
}
```

<details>
<summary>TypeScript</summary>

```ts
import { perms } from "./permly.js";

await perms.sync();
// In TypeScript the typo doesn't even compile:
// @ts-expect-error: "posts.edt" is not one of your permission names
const check = perms.user(1).can("posts.edt");
await check.catch(() => false); // at runtime, strict mode would throw
```

</details>

With `strict: false`, checks with unknown names simply return `false`. Changes (like
`givePermission("posts.edt")`) always throw, in both modes.

### Caching

Each user's roles and permissions are cached in memory for 60 seconds, so checks are fast.
Every change made through permly clears the affected entries immediately.

```js
import { createPermissions } from "permly";
import { memoryAdapter } from "permly/memory";

const perms = createPermissions({
  adapter: memoryAdapter(),
  cache: { ttl: 10 }, // seconds; `cache: false` turns it off
});

perms.clearCache(); // e.g. after changing permissions directly in the database
```

<details>
<summary>TypeScript</summary>

```ts
import { createPermissions } from "permly";
import { memoryAdapter } from "permly/memory";

const perms = createPermissions({ adapter: memoryAdapter(), cache: { ttl: 10 } });
perms.clearCache();
```

</details>

The cache lives in each Node.js process. With several servers, see
[Multiple servers](#multiple-servers).

### Errors

permly throws typed errors, so you can tell a denied user from a typo or a bad argument.

| Error                     | When                                                   | Extra fields             |
| ------------------------- | ------------------------------------------------------ | ------------------------ |
| `PermissionDeniedError`   | `authorize()` fails                                    | `missing: string[]`      |
| `PermissionNotFoundError` | a permission name doesn't exist                        | `permission, suggestion` |
| `RoleNotFoundError`       | a role name doesn't exist                              | `role, suggestion`       |
| `InvalidInputError`       | a bad argument, e.g. a name with spaces                |                          |
| `PermissionsError`        | base class of all of these; `code: "LOCK_TIMEOUT"` too | `code`                   |

Check them with `isPermissionDeniedError()` / `isPermissionsError()` rather than `instanceof`:
they also work if your app ends up with two copies of permly (e.g. one loaded with `require` and
one with `import`).

```js
import { isPermissionDeniedError } from "permly";
import { perms, setupPermissions } from "./permly.js";

await setupPermissions();

try {
  await perms.user(1).authorize(["posts.create", "posts.delete"]);
} catch (error) {
  if (!isPermissionDeniedError(error)) throw error;
  error.missing; // → ["posts.create","posts.delete"]
}
```

<details>
<summary>TypeScript</summary>

```ts
import { isPermissionDeniedError } from "permly";
import { perms, setupPermissions } from "./permly.js";

await setupPermissions();

try {
  await perms.user(1).authorize(["posts.create", "posts.delete"]);
} catch (error) {
  if (!isPermissionDeniedError(error)) throw error;
  const missing: string[] = error.missing; // narrowed to PermissionDeniedError
}
```

</details>

## Dynamic names (from requests or the database)

When permission or role names come from user input, the database, or API requests, use the type guards `isPermission()` and `isRole()` to validate them before passing them to permly methods. They never throw, even in strict mode.

<!-- test: skip -->

```js
// Example: user input from a request
const permission = req.body.permission; // any value, probably a string

if (perms.isPermission(permission)) {
  // Now TypeScript knows it's a valid permission, and permly methods accept it
  const allowed = await perms.user(42).can(permission);
}
```

Running example:

<!-- test: memory -->

```js
import { perms, setupPermissions } from "./permly.js";

await setupPermissions();

// Validate a permission name (e.g., from an API request)
const permission = "posts.edit";

if (perms.isPermission(permission)) {
  const allowed = await perms.user(1).can(permission);
  // User 1 has no permissions yet
  allowed; // → false
}
```

#### When config is empty

If you create permly without a config (dynamic schemas), `isPermission()` and `isRole()` return `false` until the database catalog is loaded. Once loaded (via `sync()`, a check, or any other database call), they check the cached catalog:

```js
import { createPermissions } from "permly";
import { MemoryAdapter } from "permly/adapter/memory";

const perms = createPermissions({ adapter: new MemoryAdapter() });

// Before sync(): always returns false (cache is empty)
perms.isPermission("posts.edit"); // → false

// After sync(): checks the cached catalog
await perms.sync();
perms.isPermission("posts.edit"); // → true (if in database)
```

For types, import the generated Permission and Role types from your permly setup file:

```ts
import { perms, type Permission, type Role } from "./permly.js";

// Now use these types for request bodies, database queries, etc.
interface UpdateRequest {
  permission: Permission;
  role: Role;
}
```

The generated `permly.js` exports these types automatically using `InferPermission` and `InferRole`. Use them for:
- Validating permission names from API requests
- Checking database values before using them
- Type-checking dynamic names in tests
- Building UI dropdowns without duplicating the permission list

## Express

Use the middleware to protect routes: it checks the user before your handler runs. It works
with Express 4 and 5. Your auth middleware sets `req.user` (with an `id`); permly reads
`req.user.id` by default.

```js
import express from "express";
import { permlyExpress, requirePermission } from "permly/express";
import { perms, setupPermissions } from "./permly.js";

await setupPermissions();
const app = express();
app.use((req, res, next) => {
  req.user = { id: req.get("x-user-id") }; // replace with your real auth
  next();
});

// One-off: one function per route.
app.delete("/posts/:id", requirePermission(perms, "posts.delete"), (req, res) => {
  res.json({ deleted: req.params.id });
});

// Or create a guard once and reuse it.
const guard = permlyExpress(perms);
app.post("/posts", guard.permission("posts.create"), (req, res) => res.json({ ok: true }));
app.get("/admin", guard.role("admin"), (req, res) => res.json({ ok: true }));
app.get("/reports", guard.anyPermission(["posts.edit", "posts.delete"]), (req, res) =>
  res.json({ ok: true }),
);

app.listen(3000);
```

<details>
<summary>TypeScript</summary>

```ts
import express from "express";
import { permlyExpress, requirePermission } from "permly/express";
import { perms, setupPermissions } from "./permly.js";

await setupPermissions();
const app = express();

app.delete("/posts/:id", requirePermission(perms, "posts.delete"), (req, res) => {
  res.json({ deleted: req.params.id });
});

const guard = permlyExpress(perms);
app.post("/posts", guard.permission("posts.create"), (_req, res) => {
  res.json({ ok: true });
});
// @ts-expect-error: typos in permission names don't compile
guard.permission("posts.crate");

app.listen(3000);
```

</details>

With `require`:

```js
const express = require("express");
const { requireRole } = require("permly/express");
const { createPermissions } = require("permly");
const { memoryAdapter } = require("permly/memory");

const perms = createPermissions({ adapter: memoryAdapter(), roles: ["admin"] });
const app = express();
app.get("/admin", requireRole(perms, "admin"), (req, res) => res.json({ ok: true }));
```

What the middleware answers:

| Situation                                         | Response                                                    |
| ------------------------------------------------- | ----------------------------------------------------------- |
| No user                                           | `401 { "error": "Unauthorized" }`                           |
| Missing permission or role                        | `403 { "error": "Forbidden", "missing": ["posts.delete"] }` |
| `own()` found no resource                         | `404 { "error": "Not Found" }`                              |
| Anything else (e.g. database down, a typo'd name) | passed to `next(err)`, i.e. your error handler              |

Guards: `permission`, `anyPermission`, `allPermissions`, `role`, `anyRole`, `allRoles`, `own`.
Simple functions: `requirePermission`, `requireAnyPermission`, `requireAllPermissions`,
`requireRole`, `requireAnyRole`, `requireAllRoles` (options as a third argument).

### Ownership in routes: `own()`

`own(permission, loadOwnerId)` loads the resource's owner and applies `canOwn`. If the loader
returns `null` / `undefined`, it answers 404 before checking anything else.

```js
import express from "express";
import { permlyExpress } from "permly/express";
import { perms, setupPermissions } from "./permly.js";

await setupPermissions();
const posts = new Map([["7", { id: "7", userId: "1", title: "Hello" }]]);

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.user = { id: req.get("x-user-id") };
  next();
});

const guard = permlyExpress(perms);
app.put(
  "/posts/:id",
  guard.own("posts.edit", async (req) => posts.get(req.params.id)?.userId),
  (req, res) => res.json({ ...posts.get(req.params.id), ...req.body }),
);
```

<details>
<summary>TypeScript</summary>

```ts
import express from "express";
import { permlyExpress } from "permly/express";
import { perms, setupPermissions } from "./permly.js";

await setupPermissions();
const posts = new Map([["7", { id: "7", userId: "1", title: "Hello" }]]);
const app = express();
const guard = permlyExpress(perms);

app.put(
  "/posts/:id",
  guard.own("posts.edit", async (req) => posts.get(String(req.params.id))?.userId),
  (req, res) => {
    res.json(posts.get(String(req.params.id)));
  },
);
```

</details>

### Options

Use options when your user id lives somewhere else (a session, a token), or to change the 401 / 403 / 404 responses.

```js
import { permlyExpress } from "permly/express";
import { perms } from "./permly.js";

const guard = permlyExpress(perms, {
  getUserId: (req) => req.session?.userId, // default: req.user?.id; may be async
  onUnauthenticated: (req, res) => res.status(401).json({ error: "Please log in" }),
  onDenied: (req, res, missing) => res.status(403).json({ error: "Forbidden" }), // hides `missing`
  onNotFound: (req, res) => res.status(404).json({ error: "Post not found" }),
});
```

<details>
<summary>TypeScript</summary>

```ts
import type { Request, Response } from "express";
import { permlyExpress } from "permly/express";
import { perms } from "./permly.js";

interface SessionRequest extends Request {
  session?: { userId?: number };
}

const guard = permlyExpress(perms, {
  getUserId: (req: SessionRequest) => req.session?.userId,
  onDenied: (_req: SessionRequest, res: Response, missing: string[]) => {
    res.status(403).json({ error: "Forbidden", missing });
  },
});
```

</details>

## Databases

permly stores roles and permissions in five tables (or collections) prefixed `perm_`. Change
the prefix with `{ prefix: "myapp_" }` on the adapter and `--prefix` on the CLI. It never adds
foreign keys to your own tables, and user ids are stored as strings (up to 64 characters).

### MySQL / MariaDB

Use this if your app uses MySQL or MariaDB. It uses the `mysql2` driver, and is tested on MySQL
8.4 (and 5.7) and MariaDB 11.

<!-- test: mysql -->

```js
import mysql from "mysql2/promise";
import { createPermissions } from "permly";
import { mysqlAdapter } from "permly/mysql";

const pool = mysql.createPool(process.env.DATABASE_URL);
const perms = createPermissions({
  adapter: mysqlAdapter(pool), // or mysqlAdapter(pool, { prefix: "myapp_" })
  permissions: ["posts.create", "posts.edit"],
  roles: ["editor"],
});

await perms.sync();
await perms.user(1).assignRole("editor");
await perms.user(1).hasRole("editor"); // true
```

<details>
<summary>TypeScript</summary>

<!-- test: mysql -->

```ts
import mysql from "mysql2/promise";
import { createPermissions } from "permly";
import { mysqlAdapter } from "permly/mysql";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL");

const perms = createPermissions({
  adapter: mysqlAdapter(mysql.createPool(url)),
  permissions: ["posts.create", "posts.edit"],
  roles: ["editor"],
});
await perms.sync();
```

</details>

- Pass a **pool** from `mysql2/promise`. With the callback API, pass `pool.promise()`.
- Create the tables with `npx permly migrate`, the generated SQL file, or
  `mysqlSchema(prefix)` / `mysqlSchemaStatements(prefix)` from `permly/mysql`.
- Names and user ids are case-sensitive (`utf8mb4_bin`).
- `syncRoles()` uses a named lock (`GET_LOCK`) per user; Galera clusters don't support it.

### Postgres

Use this if your app uses Postgres (including Supabase, Neon and RDS). It uses the `pg` driver,
and is tested on Postgres 13 and 17.

<!-- test: postgres -->

```js
import pg from "pg";
import { createPermissions } from "permly";
import { postgresAdapter } from "permly/postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const perms = createPermissions({
  adapter: postgresAdapter(pool), // or postgresAdapter(pool, { prefix: "app_", schema: "auth" })
  permissions: ["posts.create", "posts.edit"],
  roles: ["editor"],
});

await perms.sync();
await perms.user(1).assignRole("editor");
await perms.user(1).hasRole("editor"); // true
```

<details>
<summary>TypeScript</summary>

<!-- test: postgres -->

```ts
import pg from "pg";
import { createPermissions } from "permly";
import { postgresAdapter } from "permly/postgres";

const perms = createPermissions({
  adapter: postgresAdapter(new pg.Pool({ connectionString: process.env.DATABASE_URL })),
  permissions: ["posts.create", "posts.edit"],
  roles: ["editor"],
});
await perms.sync();
```

</details>

- Pass a `pg` **Pool**, not a single `Client`. pg-compatible pools like
  `@neondatabase/serverless` work too.
- **Schema:** tables live in `public` unless you pass `schema: "auth"` (and
  `npx permly migrate --schema auth`). The schema must already exist. Names are always
  schema-qualified and quoted, so permly never depends on `search_path`.
- **SSL** (Supabase, Neon, RDS, ...): configure it in `pg` as usual, e.g. `?sslmode=require` in
  the URL or `ssl: { ca }` in the pool options. For a certificate your machine doesn't trust,
  `?sslmode=no-verify` encrypts without verifying.
- **PgBouncer** in transaction mode (Supabase's pooler, Neon's pooled URL, RDS Proxy) works:
  permly only sends unnamed statements and uses transaction-scoped locks and settings. Run
  `npx permly migrate` against the direct URL if your provider recommends it for schema
  changes.
- `postgresSchema(prefix, schema)` / `postgresSchemaStatements(...)` from `permly/postgres`
  return the SQL for your own migration tool.

### MongoDB

Use this if your app uses MongoDB, with the native `mongodb` driver or with `mongoose`. permly
imports neither. It is tested on MongoDB 7 and 8, standalone and replica set.

With mongoose, pass `mongoose` itself (or a `Connection`) and connect as usual:

<!-- test: mongoose -->

```js
import mongoose from "mongoose";
import { createPermissions } from "permly";
import { mongodbAdapter } from "permly/mongodb";

const perms = createPermissions({
  adapter: mongodbAdapter(mongoose),
  permissions: ["posts.create", "posts.edit"],
  roles: ["editor"],
});

await mongoose.connect(process.env.DATABASE_URL);
await perms.sync();
await perms.user(1).assignRole("editor");
await perms.user(1).hasRole("editor"); // true
```

<details>
<summary>TypeScript</summary>

<!-- test: mongoose -->

```ts
import mongoose from "mongoose";
import { createPermissions } from "permly";
import { mongodbAdapter } from "permly/mongodb";

const perms = createPermissions({
  adapter: mongodbAdapter(mongoose),
  permissions: ["posts.create", "posts.edit"],
  roles: ["editor"],
});
await mongoose.connect(process.env.DATABASE_URL ?? "");
await perms.sync();
```

</details>

With the native driver, pass a database (not the client):

<!-- test: mongodb -->

```js
import { MongoClient } from "mongodb";
import { createPermissions } from "permly";
import { mongodbAdapter } from "permly/mongodb";

const client = new MongoClient(process.env.DATABASE_URL);
const perms = createPermissions({
  adapter: mongodbAdapter(client.db()), // the database named in the URL
  permissions: ["posts.create"],
  roles: ["editor"],
});

await perms.sync();
await perms.role("editor").givePermission("posts.create");
await perms.user("64f0c0ffee").assignRole("editor");
await perms.user("64f0c0ffee").can("posts.create"); // true
```

<details>
<summary>TypeScript</summary>

<!-- test: mongodb -->

```ts
import { MongoClient } from "mongodb";
import { createPermissions } from "permly";
import { mongodbAdapter } from "permly/mongodb";

const client = new MongoClient(process.env.DATABASE_URL ?? "");
const perms = createPermissions({
  adapter: mongodbAdapter(client.db()),
  permissions: ["posts.create"],
  roles: ["editor"],
});
await perms.sync();
```

</details>

- **Collections and indexes:** `npx permly migrate` (or the generated `.mjs` script, or
  `mongodbSetup(prefix)`) creates six collections, including `perm_locks`, and their indexes.
  permly never builds indexes when your app starts; if they're missing it throws with the exact
  command to run.
- **Atlas:** use your `mongodb+srv://` URL with the database name in the path
  (`...mongodb.net/mydb`). The database user needs `readWrite` on it, and your IP must be on the
  access list.
- **Replica sets and sharded clusters (including Atlas):** `syncRoles()` and `syncPermissions()`
  run in a transaction, so no reader sees them half done.
- **Standalone servers** have no transactions. Concurrent syncs are still safe (a lease lock runs
  them one at a time), and they remove old entries before adding new ones, so a read that
  happens mid-sync can briefly see _fewer_ roles, never extra ones.
- Names and user ids are case-sensitive (permly never sets a collation).

## Guides

Short recipes for common tasks. Each one is a complete example you can copy.

### Blog roles

A blog with admins, editors (any post), authors (their own posts) and readers:

```js
import { createPermissions } from "permly";
import { memoryAdapter } from "permly/memory";

const perms = createPermissions({
  adapter: memoryAdapter(),
  permissions: [
    "posts.create",
    "posts.edit",
    "posts.edit.own",
    "posts.delete",
    "posts.delete.own",
    "posts.publish",
    "comments.moderate",
  ],
  roles: ["admin", "editor", "author", "reader"],
});

const { createdRoles } = await perms.sync();
if (createdRoles.length > 0) {
  // First setup only: afterwards the database is the source of truth.
  await perms.role("admin").givePermission("*");
  await perms.role("editor").givePermission("posts.*", "comments.moderate");
  await perms.role("author").givePermission("posts.create", "posts.edit.own", "posts.delete.own");
}

await perms.user("ana").assignRole("author");
await perms.user("ana").canOwn("posts.delete", "ana"); // true
await perms.user("ana").can("posts.publish"); // false
```

<details>
<summary>TypeScript</summary>

```ts
import { createPermissions } from "permly";
import { memoryAdapter } from "permly/memory";

const perms = createPermissions({
  adapter: memoryAdapter(),
  permissions: ["posts.create", "posts.edit", "posts.edit.own", "posts.publish"],
  roles: ["admin", "editor", "author"],
});

const { createdRoles } = await perms.sync();
if (createdRoles.length > 0) {
  await perms.role("admin").givePermission("*");
  await perms.role("editor").givePermission("posts.*");
  await perms.role("author").givePermission("posts.create", "posts.edit.own");
}
```

</details>

### Let users edit only their own posts

Outside Express (a GraphQL resolver, a job, ...), use `canOwn` with the loaded record:

```js
import { perms, setupPermissions } from "./permly.js";

await setupPermissions();
await perms.user(1).assignRole("editor");

async function updatePost(userId, post, changes) {
  if (!(await perms.user(userId).canOwn("posts.edit", post.userId))) {
    throw new Error("You can only edit your own posts");
  }
  return { ...post, ...changes };
}

(await updatePost(1, { id: 7, userId: 1 }, { title: "New" })).title; // → "New"
```

<details>
<summary>TypeScript</summary>

```ts
import { perms, setupPermissions } from "./permly.js";

await setupPermissions();

interface Post {
  id: number;
  userId: number;
  title?: string;
}

async function updatePost(userId: number, post: Post, changes: Partial<Post>): Promise<Post> {
  if (!(await perms.user(userId).canOwn("posts.edit", post.userId))) {
    throw new Error("You can only edit your own posts");
  }
  return { ...post, ...changes };
}
```

</details>

In Express, use [`guard.own()`](#ownership-in-routes-own).

### Protect a group of admin routes

Put the guard on a router once, instead of on every route:

```js
import express from "express";
import { permlyExpress } from "permly/express";
import { perms } from "./permly.js";

const guard = permlyExpress(perms);
const admin = express.Router();
admin.use(guard.role("admin")); // every route below requires the admin role
admin.get("/users", (req, res) => res.json([]));
admin.delete("/posts/:id", (req, res) => res.json({ deleted: req.params.id }));

const app = express();
app.use("/admin", admin);
```

<details>
<summary>TypeScript</summary>

```ts
import express from "express";
import { permlyExpress } from "permly/express";
import { perms } from "./permly.js";

const guard = permlyExpress(perms);
const admin = express.Router();
admin.use(guard.role("admin"));
admin.get("/users", (_req, res) => {
  res.json([]);
});

const app = express();
app.use("/admin", admin);
```

</details>

### Promote a user

Use this when a user's job changes, for example from viewer to editor.

```js
import { perms, setupPermissions } from "./permly.js";

await setupPermissions();
await perms.user(3).assignRole("viewer");

// Promote: add the new role and drop the old one...
await perms.user(3).assignRole("editor");
await perms.user(3).removeRole("viewer");
// ...or set the exact list in one step:
await perms.user(3).syncRoles(["editor"]);

await perms.user(3).getRoles(); // → ["editor"]
```

<details>
<summary>TypeScript</summary>

```ts
import { perms, setupPermissions } from "./permly.js";

await setupPermissions();
await perms.user(3).syncRoles(["editor"]);
const roles: string[] = await perms.user(3).getRoles();
```

</details>

The change applies right away, including in this process's cache.

### Give one user an extra permission

No need for a new role when one person needs one more thing:

```js
import { perms, setupPermissions } from "./permly.js";

await setupPermissions();
await perms.user(4).assignRole("viewer");
await perms.user(4).givePermission("posts.create"); // just for this user

await perms.user(4).can("posts.create"); // true
await perms.user(5).can("posts.create"); // false

await perms.user(4).revokePermission("posts.create"); // and back
```

<details>
<summary>TypeScript</summary>

```ts
import { perms, setupPermissions } from "./permly.js";

await setupPermissions();
await perms.user(4).givePermission("posts.create");
await perms.user(4).revokePermission("posts.create");
```

</details>

### JWT authentication

permly needs the user's id; where it comes from is up to you. With JSON Web Tokens (here with
[`jsonwebtoken`](https://www.npmjs.com/package/jsonwebtoken)):

```js
import express from "express";
import jwt from "jsonwebtoken";
import { permlyExpress } from "permly/express";
import { perms } from "./permly.js";

const SECRET = process.env.JWT_SECRET ?? "change-me";

function authenticate(req, res, next) {
  const token = req.get("authorization")?.replace(/^Bearer /, "");
  try {
    if (token) req.user = { id: jwt.verify(token, SECRET).sub };
  } catch {
    // invalid or expired token: no user, so guards answer 401
  }
  next();
}

const app = express();
app.use(authenticate);
const guard = permlyExpress(perms);
app.post("/posts", guard.permission("posts.create"), (req, res) => res.json({ ok: true }));
```

<details>
<summary>TypeScript</summary>

```ts
import express, { type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { permlyExpress } from "permly/express";
import { perms } from "./permly.js";

const SECRET = process.env.JWT_SECRET ?? "change-me";

function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = req.get("authorization")?.replace(/^Bearer /, "");
  try {
    if (token) Object.assign(req, { user: { id: jwt.verify(token, SECRET).sub } });
  } catch {
    // invalid or expired token: no user, so guards answer 401
  }
  next();
}

const app = express();
app.use(authenticate);
app.post("/posts", permlyExpress(perms).permission("posts.create"), (_req, res) => {
  res.json({ ok: true });
});
```

</details>

### Show or hide buttons in the frontend

The server stays in charge; the frontend just asks what to show. Send the user's permissions
(expanded, so wildcards become real names):

```js
import express from "express";
import { perms } from "./permly.js";

const app = express();
app.get("/me/permissions", async (req, res) => {
  const permissions = await perms.user(req.user.id).getPermissions({ expand: true });
  res.json({ permissions });
});

// In the browser:
//   const { permissions } = await (await fetch("/me/permissions")).json();
//   deleteButton.hidden = !permissions.includes("posts.delete");
```

<details>
<summary>TypeScript</summary>

```ts
import express from "express";
import { perms } from "./permly.js";

const app = express();
app.get("/me/permissions/:userId", async (req, res) => {
  const permissions = await perms.user(String(req.params.userId)).getPermissions({ expand: true });
  res.json({ permissions });
});
```

</details>

Always check again on the server: hiding a button is not security.

### Multiple servers

Each Node.js process has its own cache. A change made on server A is visible on server A
immediately, and on server B once B's cache entry expires (60 seconds by default). Options:

- Lower the TTL, e.g. `cache: { ttl: 5 }`, if changes must show up faster.
- `cache: false` to always read from the database (one indexed query per check).
- Call `perms.clearCache()` when you know something changed (e.g. from a message queue).

```js
import { createPermissions } from "permly";
import { memoryAdapter } from "permly/memory";

// e.g. one short TTL for all servers
const perms = createPermissions({ adapter: memoryAdapter(), cache: { ttl: 5 } });
```

<details>
<summary>TypeScript</summary>

```ts
import { createPermissions } from "permly";
import { memoryAdapter } from "permly/memory";

const perms = createPermissions({ adapter: memoryAdapter(), cache: false });
```

</details>

A shared Redis cache is planned for a later version.

### Testing your app

Use the memory adapter in tests: no database, and each test gets a clean slate.

```js
import assert from "node:assert/strict";
import { createPermissions } from "permly";
import { memoryAdapter } from "permly/memory";

async function makePerms() {
  const perms = createPermissions({
    adapter: memoryAdapter(),
    permissions: ["posts.create", "posts.delete"],
    roles: ["editor"],
  });
  await perms.sync();
  await perms.role("editor").givePermission("posts.create");
  return perms;
}

const perms = await makePerms();
await perms.user(1).assignRole("editor");
assert.equal(await perms.user(1).can("posts.create"), true);
assert.equal(await perms.user(1).can("posts.delete"), false);
```

<details>
<summary>TypeScript</summary>

```ts
import assert from "node:assert/strict";
import { createPermissions } from "permly";
import { memoryAdapter } from "permly/memory";

const perms = createPermissions({
  adapter: memoryAdapter(),
  permissions: ["posts.create"],
  roles: ["editor"],
});
await perms.sync();
assert.equal(await perms.user(1).can("posts.create"), false);
```

</details>

## API reference

Every public function in one place. The sections above explain them with examples.

### `createPermissions(config)`

Creates your `perms` object. Call it once and share the result.

| Option        | Type                         | Default       |                                              |
| ------------- | ---------------------------- | ------------- | -------------------------------------------- |
| `adapter`     | adapter                      | required      | `memoryAdapter()`, `mysqlAdapter(pool)`, ... |
| `permissions` | `string[]`                   | `[]`          | created by `sync()`; typed in TypeScript     |
| `roles`       | `string[]`                   | `[]`          | created by `sync()`; typed in TypeScript     |
| `cache`       | `{ ttl?: number }` / `false` | `{ ttl: 60 }` | seconds                                      |
| `strict`      | `boolean`                    | `true`        | unknown names in checks throw                |

Returns `perms` with: `sync()`, `user(id)`, `role(name)`, `createRole(...names)`,
`createPermission(...names)`, `deleteRole(name)`, `deletePermission(name)`, `getAllRoles()`,
`getAllPermissions()`, `clearCache()`.

### `perms.user(id)`

Everything about one user: their roles, extra permissions and checks.

| Method                                                     | Returns             |
| ---------------------------------------------------------- | ------------------- |
| `assignRole(...roles)`, `removeRole(...roles)`             | `Promise<void>`     |
| `syncRoles(roles)`                                         | `Promise<void>`     |
| `givePermission(...names)`, `revokePermission(...names)`   | `Promise<void>`     |
| `can(name)`, `canAny(names)`, `canAll(names)`              | `Promise<boolean>`  |
| `canOwn(name, ownerId)`                                    | `Promise<boolean>`  |
| `authorize(name or names)`                                 | throws if denied    |
| `hasRole(role)`, `hasAnyRole(roles)`, `hasAllRoles(roles)` | `Promise<boolean>`  |
| `getRoles()`                                               | `Promise<string[]>` |
| `getPermissions({ expand? })`                              | `Promise<string[]>` |

### `perms.role(name)`

Everything about one role: its permissions.

`givePermission(...names)`, `revokePermission(...names)`, `syncPermissions(names)`,
`getPermissions({ expand? })`.

### Adapters

An adapter connects permly to your database. Pick the one for your database.

| Import            | Factory                                     | Also exports                                     |
| ----------------- | ------------------------------------------- | ------------------------------------------------ |
| `permly/memory`   | `memoryAdapter()`                           |                                                  |
| `permly/mysql`    | `mysqlAdapter(pool, { prefix })`            | `mysqlSchema()`, `mysqlSchemaStatements()`       |
| `permly/postgres` | `postgresAdapter(pool, { prefix, schema })` | `postgresSchema()`, `postgresSchemaStatements()` |
| `permly/mongodb`  | `mongodbAdapter(db, { prefix })`            | `mongodbSetup()`                                 |

Writing your own adapter? Implement the `PermissionAdapter` interface (exported as a type from
`permly`) and run the shared test suite against it; see [CONTRIBUTING.md](https://github.com/PJPhukan/permly/blob/main/CONTRIBUTING.md).

### CLI

The `permly` command sets up your project and database.

```text
npx permly init       Create the migration file and a starter src/permly.(js|ts)
npx permly migrate    Create the tables / collections in DATABASE_URL (never changes existing ones)

--db <name>           mysql, postgres or mongodb
--prefix <prefix>     Table prefix, default perm_
--schema <name>       Postgres schema, default public (must already exist)
--out <dir>           init: folder for the migration file, default migrations
--ts / --js           init: language of the starter file (default: detected)
--esm / --cjs         init: module format for JavaScript (default: detected)
--force               init: overwrite existing files
--url <url>           migrate: database URL instead of DATABASE_URL
--yes                 migrate: don't ask for confirmation
```

In CI nothing is ever prompted: use `npx permly init --db mysql` and `npx permly migrate --yes`.
`migrate` shows the target database but never prints its password.

## FAQ and troubleshooting

Common questions and error messages, with the fix for each.

**`Permission "x" does not exist. It is listed in your config but not in the database. Did you
run perms.sync()?`** Call `perms.sync()` (or the generated `setupPermissions()`) once at
startup, before any check.

**`Permission "posts.edt" does not exist. Did you mean "posts.edit"?`** A typo in a name. In
TypeScript, list your names in `createPermissions()` to catch these at compile time. If unknown
names are expected (e.g. names coming from user input), use `strict: false` so checks return
`false` instead.

**`permly's tables were not found` / `collections or indexes are missing`** Run
`npx permly migrate` (with the same `--prefix`, and `--schema` for Postgres).

**`LOCK_TIMEOUT`** Two `syncRoles()` calls for the same user (or `syncPermissions()` for the
same role) overlapped for more than 10 seconds. It's rare, usually a very slow database. Retry,
or avoid syncing the same user from many places at once.

**Galera cluster (MySQL/MariaDB)** `syncRoles()` uses `GET_LOCK`, which Galera doesn't
support. Everything else works.

**Prisma shows drift after `npx permly migrate`** Prisma treats tables it doesn't manage as
drift and may offer to reset the database. Don't run permly's SQL alongside `prisma migrate` in
the same database for now; keep permly's tables in a database Prisma doesn't migrate. Proper
Prisma support is planned.

**TypeScript: `Module has no default export` for `pg` or `mongoose`** Enable `esModuleInterop`
in `tsconfig.json` (it's on by default in new projects), or use `"module": "NodeNext"`.

**TypeScript can't find `permly/mysql` (or another subpath)** Use a recent TypeScript. Old
`moduleResolution: "node"` setups are supported, but `"NodeNext"` or `"Bundler"` is
recommended.

**Does permly work without Express?** Yes. The core works anywhere (Fastify, Koa, Next.js,
GraphQL, background jobs); the Express middleware is an optional extra.

**Does permly change my users table?** No. It only uses its own `perm_*` tables and stores your
user ids as strings.

## Coming from Laravel (spatie/laravel-permission)

The ideas are the same; permly's calls are async and hang off `perms.user(id)`.

| spatie/laravel-permission                | permly                                            |
| ---------------------------------------- | ------------------------------------------------- |
| `Permission::create(['name' => 'edit'])` | `permissions: [...]` in config + `perms.sync()`   |
| `Role::create(['name' => 'writer'])`     | `roles: [...]` in config, or `perms.createRole()` |
| `$role->givePermissionTo('edit')`        | `perms.role("writer").givePermission("edit")`     |
| `$role->revokePermissionTo('edit')`      | `perms.role("writer").revokePermission("edit")`   |
| `$role->syncPermissions([...])`          | `perms.role("writer").syncPermissions([...])`     |
| `$user->assignRole('writer')`            | `perms.user(id).assignRole("writer")`             |
| `$user->removeRole('writer')`            | `perms.user(id).removeRole("writer")`             |
| `$user->syncRoles([...])`                | `perms.user(id).syncRoles([...])`                 |
| `$user->givePermissionTo('edit')`        | `perms.user(id).givePermission("edit")`           |
| `$user->can('edit')` / `hasPermissionTo` | `await perms.user(id).can("edit")`                |
| `$user->hasAnyPermission([...])`         | `perms.user(id).canAny([...])`                    |
| `$user->hasAllPermissions([...])`        | `perms.user(id).canAll([...])`                    |
| `$user->hasRole('writer')`               | `perms.user(id).hasRole("writer")`                |
| `$user->hasAnyRole([...])`               | `perms.user(id).hasAnyRole([...])`                |
| `$user->getAllPermissions()`             | `perms.user(id).getPermissions({ expand: true })` |
| `$user->getRoleNames()`                  | `perms.user(id).getRoles()`                       |
| `middleware('permission:edit')`          | `requirePermission(perms, "edit")`                |
| `middleware('role:admin')`               | `requireRole(perms, "admin")`                     |
| Wildcard permissions (`posts.*`)         | Built in                                          |
| Policies for "own" records               | `canOwn()` / `guard.own()`                        |
| Teams                                    | Planned (the `team_id` column is already there)   |

## Support permly

permly is free and open source. If it saves you time, please consider
[sponsoring its development on GitHub](https://github.com/sponsors/PJPhukan). A star on the
repository or a mention to a friend helps too. Questions and ideas are welcome in
[GitHub Discussions](https://github.com/PJPhukan/permly/discussions).

## Contributing

Contributions are welcome: bug reports, docs, tests and new adapters. See
[CONTRIBUTING.md](https://github.com/PJPhukan/permly/blob/main/CONTRIBUTING.md) for setup, tests and how to add an adapter.

## Security

Please report security issues privately, not in public issues. See
[SECURITY.md](https://github.com/PJPhukan/permly/blob/main/SECURITY.md) for how, and what to expect.

## License

[MIT](https://github.com/PJPhukan/permly/blob/main/LICENSE) © 2026 Paragjyoti Phukan
