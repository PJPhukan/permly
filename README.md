# permly

Simple roles & permissions for Node.js. Zero dependencies.

> **Draft.** The full README (API reference, Express, caching, FAQ) comes before the first
> release. This covers the core idea and MySQL setup.

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
- A user's roles and permissions are loaded in a single indexed query and cached in memory for
  60 seconds (`cache: { ttl }`). The cache is per process: on several servers, a change made on
  one server shows up on the others after the TTL.
