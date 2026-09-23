import mysqlCallback from "mysql2";
import mysql, { type Pool } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mysqlAdapter, mysqlSchema, mysqlSchemaStatements } from "../../src/adapters/mysql";
import { createPermissions } from "../../src/core/create-permissions";
import { InvalidInputError, isPermissionsError } from "../../src/core/errors";
import { userLockName } from "../../src/adapters/sql-shared";
import { runAdapterContract } from "./adapter-contract";
import { connectOrSkip } from "./db";

const PREFIX = "permly_test_";

const targets = [
  {
    label: "MySQL 8",
    envVar: "PERMLY_MYSQL_URL",
    url: process.env.PERMLY_MYSQL_URL ?? "mysql://root:permly@127.0.0.1:33061/permly",
  },
  {
    label: "MariaDB 11",
    envVar: "PERMLY_MARIADB_URL",
    url: process.env.PERMLY_MARIADB_URL ?? "mysql://root:permly@127.0.0.1:33062/permly",
  },
];

async function openPool(url: string): Promise<Pool> {
  const pool = mysql.createPool({ uri: url, connectionLimit: 25, connectTimeout: 3000 });
  try {
    await pool.query("SELECT 1");
    return pool;
  } catch (err) {
    await pool.end();
    throw err;
  }
}

const TABLES = ["user_permissions", "user_roles", "role_permissions", "permissions", "roles"];

async function dropTables(pool: Pool, prefix = PREFIX) {
  for (const table of TABLES) await pool.query(`DROP TABLE IF EXISTS \`${prefix}${table}\``);
}

async function count(pool: Pool, table: string, where = "1=1", values: unknown[] = []) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n FROM \`${PREFIX}${table}\` WHERE ${where}`,
    values,
  );
  return Number((rows as { n: number }[])[0]?.n);
}

for (const target of targets) {
  const connected = await connectOrSkip(target.label, target.envVar, () => openPool(target.url));

  describe.skipIf(!connected)(target.label, () => {
    const pool = connected as Pool;

    beforeAll(async () => {
      await dropTables(pool);
      for (const statement of mysqlSchemaStatements(PREFIX)) await pool.query(statement);
    });

    afterAll(async () => {
      await dropTables(pool);
      await pool.end();
    });

    // Deleting every role and permission cascades through all link tables.
    async function reset() {
      await pool.query(`DELETE FROM \`${PREFIX}roles\``);
      await pool.query(`DELETE FROM \`${PREFIX}permissions\``);
    }

    runAdapterContract(target.label, async () => {
      await reset();
      return mysqlAdapter(pool, { prefix: PREFIX });
    });

    describe("MySQL specifics", () => {
      const adapter = () => mysqlAdapter(pool, { prefix: PREFIX });
      beforeEach(reset);

      it("schema is idempotent", async () => {
        for (const statement of mysqlSchemaStatements(PREFIX)) await pool.query(statement);
      });

      it("names are case-sensitive", async () => {
        await adapter().createRoles(["Admin", "admin"]);
        expect((await adapter().listRoles()).sort()).toEqual(["Admin", "admin"]);
      });

      it("user ids are case-sensitive", async () => {
        const db = adapter();
        await db.createRoles(["admin"]);
        await db.addUserRoles("abc", ["admin"]);
        expect((await db.getUserAccess("ABC")).roles).toEqual([]);
      });

      it("stores unicode names intact", async () => {
        // Core only allows [A-Za-z0-9_-] names, but adapters store whatever they are given.
        await adapter().createRoles(["rôle-ünïcode"]);
        expect(await adapter().listRoles()).toEqual(["rôle-ünïcode"]);
      });

      it("uses the configured prefix", async () => {
        await dropTables(pool, "other_");
        for (const statement of mysqlSchemaStatements("other_")) await pool.query(statement);
        const db = mysqlAdapter(pool, { prefix: "other_" });
        await db.createRoles(["only-here"]);
        expect(await db.listRoles()).toEqual(["only-here"]);
        expect(await adapter().listRoles()).toEqual([]);
        await dropTables(pool, "other_");
      });

      it("splits large lists into batches", async () => {
        const db = adapter();
        const many = Array.from({ length: 1200 }, (_, i) => `p.n${i}`);
        await db.createRoles(["big"]);
        await db.createPermissions(many);
        expect((await db.listPermissions()).length).toBe(1200);

        await db.addRolePermissions("big", many);
        expect((await db.getRolePermissions("big")).length).toBe(1200);
        await db.setRolePermissions("big", many.slice(0, 1100));
        expect((await db.getRolePermissions("big")).length).toBe(1100);
        await db.removeRolePermissions("big", many);
        expect(await db.getRolePermissions("big")).toEqual([]);

        await db.addUserPermissions("1", many);
        expect((await db.getUserAccess("1")).directPermissions.length).toBe(1200);
        await db.removeUserPermissions("1", many);
        expect((await db.getUserAccess("1")).directPermissions).toEqual([]);
      });

      it("cascades deletes through the link tables", async () => {
        const db = adapter();
        await db.createRoles(["editor", "viewer"]);
        await db.createPermissions(["posts.edit", "posts.view"]);
        await db.addRolePermissions("editor", ["posts.edit", "posts.view"]);
        await db.addRolePermissions("viewer", ["posts.view"]);
        await db.addUserRoles("1", ["editor", "viewer"]);
        await db.addUserPermissions("1", ["posts.edit"]);

        await db.deleteRole("editor");
        expect(await count(pool, "user_roles")).toBe(1);
        expect(await count(pool, "role_permissions")).toBe(1);

        await db.deletePermission("posts.view");
        expect(await count(pool, "role_permissions")).toBe(0);
        await db.deletePermission("posts.edit");
        expect(await count(pool, "user_permissions")).toBe(0);
      });

      it("handles 20 parallel grants for one user without duplicates or errors", async () => {
        const perms = createPermissions({
          adapter: adapter(),
          cache: false,
          roles: ["editor", "viewer"],
          permissions: ["posts.edit", "posts.view"],
        });
        await perms.sync();
        const user = perms.user("u-1");

        const results = await Promise.allSettled(
          Array.from({ length: 20 }, (_, i) =>
            i % 2 === 0 ? user.assignRole("editor", "viewer") : user.givePermission("posts.edit"),
          ),
        );
        expect(results.filter((r) => r.status === "rejected")).toEqual([]);
        expect(await count(pool, "user_roles", "user_id = ?", ["u-1"])).toBe(2);
        expect(await count(pool, "user_permissions", "user_id = ?", ["u-1"])).toBe(1);
        expect(await user.getRoles()).toEqual(["editor", "viewer"]);
      });

      it("handles parallel syncRoles / syncPermissions (transactions)", async () => {
        const perms = createPermissions({
          adapter: adapter(),
          cache: false,
          roles: ["a", "b", "c"],
          permissions: ["x.one", "x.two", "x.three"],
        });
        await perms.sync();
        const options: ("a" | "b" | "c")[][] = [["a"], ["a", "b"], ["b", "c"], ["a", "b", "c"]];

        // Round 1 starts with no rows for the user, round 2 with existing rows.
        for (let round = 1; round <= 2; round++) {
          // allSettled so a failure can't leave transactions running into the next test.
          const results = await Promise.allSettled(
            Array.from({ length: 20 }, (_, i) =>
              i % 2 === 0
                ? perms.user("u-2").syncRoles(options[i % 4] ?? [])
                : perms.role("a").syncPermissions(i % 4 === 1 ? ["x.one"] : ["x.two", "x.three"]),
            ),
          );
          expect(results.filter((r) => r.status === "rejected")).toEqual([]);
          // The final state must be exactly one of the requested lists, never a mix or duplicate.
          const roles = await perms.user("u-2").getRoles();
          expect(options.map((o) => o.join())).toContain(roles.join());
          expect(await count(pool, "user_roles", "user_id = ?", ["u-2"])).toBe(roles.length);
          expect([["x.one"], ["x.three", "x.two"]].map((o) => o.join())).toContain(
            (await perms.role("a").getPermissions()).join(),
          );
        }
      });

      it("concurrent setUserRoles on a new user never leaves a mix", async () => {
        const db = adapter();
        await db.createRoles(["a", "b", "c"]);
        const mixed: string[] = [];
        for (let i = 0; i < 50; i++) {
          const user = `fresh-${i}`;
          await Promise.all([db.setUserRoles(user, ["a"]), db.setUserRoles(user, ["b", "c"])]);
          const roles = (await db.getUserAccess(user)).roles.sort().join();
          if (roles !== "a" && roles !== "b,c") mixed.push(`${user}: ${roles}`);
        }
        expect(mixed).toEqual([]);
      });

      it("syncRoles works for a 64-character user id", async () => {
        const db = adapter();
        await db.createRoles(["a", "b"]);
        const id = "x".repeat(64);
        await db.setUserRoles(id, ["a", "b"]);
        expect((await db.getUserAccess(id)).roles.sort()).toEqual(["a", "b"]);
      });

      it("returns pooled connections at the default isolation level", async () => {
        // One connection, so every call below is guaranteed to reuse it.
        const single = mysql.createPool({ uri: target.url, connectionLimit: 1 });
        const scalar = async (sql: string, db: Pick<Pool, "query"> = single) => {
          const [rows] = await db.query(sql);
          return Object.values((rows as Record<string, unknown>[])[0] ?? {})[0];
        };
        try {
          const db = mysqlAdapter(single, { prefix: PREFIX });
          await db.createRoles(["a"]);
          const connectionId = await scalar("SELECT CONNECTION_ID()");

          await db.setUserRoles("iso", ["a"]);
          await db.setRolePermissions("a", []);

          expect(await scalar("SELECT CONNECTION_ID()")).toBe(connectionId);
          expect(await scalar("SELECT @@SESSION.transaction_isolation")).toBe("REPEATABLE-READ");

          // And the next transaction really is REPEATABLE READ: a row another connection commits
          // mid-transaction stays invisible to it.
          const connection = await single.getConnection();
          try {
            await connection.beginTransaction();
            const countRoles = `SELECT COUNT(*) FROM \`${PREFIX}roles\``;
            const before = await scalar(countRoles, connection);
            await pool.query(`INSERT INTO \`${PREFIX}roles\` (name) VALUES ('iso-probe')`);
            expect(await scalar(countRoles, connection)).toBe(before);
            await connection.rollback();
          } finally {
            connection.release();
          }
        } finally {
          await single.end();
        }
      });

      it("getUserAccess is one indexed query", async () => {
        // Enough data that the optimizer picks indexes the way it would in production.
        const db = adapter();
        const roles = Array.from({ length: 30 }, (_, i) => `role${i}`);
        const permissions = Array.from({ length: 200 }, (_, i) => `perm.n${i}`);
        await db.createRoles(roles);
        await db.createPermissions(permissions);
        for (const [i, role] of roles.entries()) {
          await db.addRolePermissions(role, permissions.slice(i * 5, i * 5 + 20));
        }
        const [[firstRole]] = (await pool.query(
          `SELECT MIN(id) AS id FROM \`${PREFIX}roles\``,
        )) as unknown as [[{ id: number }]];
        const [[firstPerm]] = (await pool.query(
          `SELECT MIN(id) AS id FROM \`${PREFIX}permissions\``,
        )) as unknown as [[{ id: number }]];
        const userRoleRows: unknown[] = [];
        const userPermRows: unknown[] = [];
        for (let u = 0; u < 2000; u++) {
          userRoleRows.push(`user${u}`, firstRole.id + (u % 30));
          userPermRows.push(`user${u}`, firstPerm.id + (u % 200));
        }
        const pairs = (n: number) => Array.from({ length: n }, () => "(?, ?)").join(", ");
        await pool.query(
          `INSERT INTO \`${PREFIX}user_roles\` (user_id, role_id) VALUES ${pairs(2000)}`,
          userRoleRows,
        );
        await pool.query(
          `INSERT INTO \`${PREFIX}user_permissions\` (user_id, permission_id) VALUES ${pairs(2000)}`,
          userPermRows,
        );
        for (const table of TABLES) await pool.query(`ANALYZE TABLE \`${PREFIX}${table}\``);

        // Capture the SQL getUserAccess actually sends.
        const sent: { sql: string; values: unknown[] }[] = [];
        const recording = {
          query: (options: { sql: string }, v: unknown[] = []) => {
            sent.push({ sql: options.sql, values: v });
            return pool.query(options, v);
          },
          getConnection: () => pool.getConnection(),
        };
        const access = await mysqlAdapter(recording as never, { prefix: PREFIX }).getUserAccess(
          "user7",
        );
        expect(access.roles).toEqual(["role7"]);
        const [only] = sent;
        expect(sent).toHaveLength(1);
        if (!only) return;

        const [plan] = await pool.query(`EXPLAIN ${only.sql}`, only.values);
        const steps = (plan as { table: string; type: string; key: string | null }[]).filter(
          (step) => step.table !== null && !step.table.startsWith("<"), // skip UNION RESULT
        );
        if (process.env.PERMLY_EXPLAIN === "1") {
          process.stderr.write(
            `${target.label} EXPLAIN: ${steps.map((s) => `${s.table}:${s.type}:${s.key}`).join("  ")}\n`,
          );
        }
        for (const step of steps) {
          expect(step.type, `full scan on ${step.table}`).not.toBe("ALL");
          expect(step.key, `no index used on ${step.table}`).not.toBeNull();
        }
      });
    });
  });
}

describe("mysqlAdapter input checks (no database needed)", () => {
  it("rejects a callback-style pool", () => {
    const callbackPool = mysqlCallback.createPool({ host: "127.0.0.1" });
    expect(() => mysqlAdapter(callbackPool as never)).toThrow(
      'mysqlAdapter() got a callback-style mysql2 pool. Pass pool.promise(), or create the pool with "mysql2/promise".',
    );
    expect(() => mysqlAdapter(callbackPool.promise())).not.toThrow();
    callbackPool.end();
  });

  it("rejects a single connection and non-pools", () => {
    expect(() => mysqlAdapter({ query: async () => [[], []] } as never)).toThrow(
      "not a single connection",
    );
    expect(() => mysqlAdapter(undefined as never)).toThrow("expects a mysql2 pool");
  });

  it.each(["perm-", "perm_; DROP TABLE users; --", "`x`", "a".repeat(33), 5])(
    "rejects unsafe prefix %j",
    (prefix) => {
      const pool = mysql.createPool({ host: "127.0.0.1" });
      expect(() => mysqlAdapter(pool, { prefix: prefix as string })).toThrow(InvalidInputError);
      void pool.end();
    },
  );

  it("builds the schema from one place with the prefix", () => {
    const sql = mysqlSchema("app_");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS `app_roles`");
    expect(sql).toContain("REFERENCES `app_roles` (`id`) ON DELETE CASCADE");
    expect(sql).toContain("COLLATE=utf8mb4_bin");
    expect(sql).not.toContain("perm_");
    expect(mysqlSchemaStatements()).toHaveLength(5);
    expect(() => mysqlSchema("bad name")).toThrow(InvalidInputError);
  });
});

describe("mysqlAdapter transactions (fake pool)", () => {
  /** `lockGranted`: true = GET_LOCK returns 1, false = 0 (timeout), null = NULL (error). */
  function fakePool(failures: { code: string }[], lockGranted: boolean | null = true) {
    const log: string[] = [];
    const lockNames: string[] = [];
    const connection = {
      beginTransaction: async () => void log.push("begin"),
      commit: async () => void log.push("commit"),
      rollback: async () => void log.push("rollback"),
      release: () => void log.push("release"),
      query: async (
        { sql }: { sql: string },
        values: unknown[] = [],
      ): Promise<[unknown, unknown]> => {
        if (sql.includes("GET_LOCK")) {
          lockNames.push(String(values[0]));
          log.push(lockGranted === true ? "lock" : "lock-timeout");
          return [[{ locked: lockGranted === true ? 1 : lockGranted === false ? 0 : null }], []];
        }
        if (sql.includes("RELEASE_LOCK")) {
          lockNames.push(String(values[0]));
          log.push("unlock");
          return [[], []];
        }
        if (sql.startsWith("SET TRANSACTION")) {
          log.push("read-committed");
          return [[], []];
        }
        if (sql.includes("FOR UPDATE")) {
          log.push("lock-role");
          return [[{ id: 1 }], []];
        }
        const failure = failures.shift();
        if (failure) {
          log.push(`fail:${failure.code}`);
          throw Object.assign(new Error(failure.code), failure);
        }
        log.push("query");
        return [[], []] as [unknown, unknown];
      },
    };
    return {
      log,
      lockNames,
      pool: { query: connection.query, getConnection: async () => connection },
    };
  }

  it("retries once on deadlock and always releases the connection", async () => {
    const { pool, log } = fakePool([{ code: "ER_LOCK_DEADLOCK" }]);
    await mysqlAdapter(pool).setUserRoles("1", ["a"]);
    expect(log).toEqual([
      "lock",
      "read-committed",
      "begin",
      "fail:ER_LOCK_DEADLOCK",
      "rollback",
      "unlock",
      "release",
      "lock",
      "read-committed",
      "begin",
      "query",
      "query",
      "commit",
      "unlock",
      "release",
    ]);
  });

  it("locks the role row in setRolePermissions", async () => {
    const { pool, log } = fakePool([]);
    await mysqlAdapter(pool).setRolePermissions("r", ["p"]);
    expect(log).toEqual([
      "read-committed",
      "begin",
      "lock-role",
      "query",
      "query",
      "commit",
      "release",
    ]);
  });

  it.each([
    [false, "timeout"],
    [null, "error"],
  ])(
    "throws a clear PermissionsError when GET_LOCK returns %s (%s), without retrying",
    async (granted, _meaning) => {
      const { pool, log } = fakePool([], granted);
      const error = await mysqlAdapter(pool)
        .setUserRoles("1", ["a"])
        .catch((e: unknown) => e);
      expect(isPermissionsError(error)).toBe(true);
      expect(error).toMatchObject({ code: "LOCK_TIMEOUT" });
      expect((error as Error).message).toMatch(
        /^Timed out after 10s waiting for lock "permly:perm_:[0-9a-f]{16}", held by another syncRoles\(\) for the same user\.$/,
      );
      // No transaction was started, and the lock was never held, so neither is undone.
      expect(log).toEqual(["lock-timeout", "release"]);
    },
  );

  it("uses a short hashed lock name, even for a 64-character user id", async () => {
    const longId = "u".repeat(64);
    const { pool, lockNames } = fakePool([]);
    await mysqlAdapter(pool, { prefix: "a".repeat(32) }).setUserRoles(longId, ["a"]);

    const [taken, released] = lockNames;
    expect(taken).toBe(released); // same name for GET_LOCK and RELEASE_LOCK
    expect(taken).toMatch(/^permly:a{32}:[0-9a-f]{16}$/);
    expect(taken?.length).toBeLessThanOrEqual(64);
    expect(taken).not.toContain(longId);
    expect(userLockName("perm_", "1")).not.toBe(userLockName("perm_", "2"));
    expect(userLockName("perm_", "1")).not.toBe(userLockName("other_", "1"));
  });

  it("gives up after one retry", async () => {
    const { pool, log } = fakePool([{ code: "ER_CHECKREAD" }, { code: "ER_LOCK_DEADLOCK" }]);
    await expect(mysqlAdapter(pool).setUserRoles("1", ["p"])).rejects.toThrow("ER_LOCK_DEADLOCK");
    expect(log.filter((l) => l === "release")).toHaveLength(2);
    expect(log.filter((l) => l === "unlock")).toHaveLength(2);
  });

  it("does not retry other errors", async () => {
    const { pool, log } = fakePool([{ code: "ER_BAD_FIELD_ERROR" }]);
    await expect(mysqlAdapter(pool).setUserRoles("1", ["a"])).rejects.toThrow();
    expect(log).toEqual([
      "lock",
      "read-committed",
      "begin",
      "fail:ER_BAD_FIELD_ERROR",
      "rollback",
      "unlock",
      "release",
    ]);
  });
});
