import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  postgresAdapter,
  postgresSchema,
  postgresSchemaStatements,
} from "../../src/adapters/postgres";
import { userLockKey } from "../../src/adapters/postgres-lock";
import { createPermissions } from "../../src/core/create-permissions";
import { InvalidInputError, isPermissionsError } from "../../src/core/errors";
import { runAdapterContract } from "./adapter-contract";
import { connectOrSkip } from "./db";

const PREFIX = "permly_test_";
const TABLES = ["user_permissions", "user_roles", "role_permissions", "permissions", "roles"];

const targets = [
  {
    label: "Postgres 13",
    envVar: "PERMLY_PG13_URL",
    url: process.env.PERMLY_PG13_URL ?? "postgres://postgres:permly@127.0.0.1:54313/permly",
    ssl: false,
  },
  {
    // The docker-compose Postgres 17 has SSL on with a self-signed certificate.
    label: "Postgres 17 (SSL)",
    envVar: "PERMLY_PG17_URL",
    url: process.env.PERMLY_PG17_URL ?? "postgres://postgres:permly@127.0.0.1:54317/permly",
    ssl: true,
  },
];

type Pool = pg.Pool;

async function openPool(url: string, ssl: boolean, extra: pg.PoolConfig = {}): Promise<Pool> {
  const pool = new pg.Pool({
    connectionString: url,
    max: 25,
    connectionTimeoutMillis: 3000,
    ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    ...extra,
  });
  try {
    await pool.query("SELECT 1");
    return pool;
  } catch (err) {
    await pool.end();
    throw err;
  }
}

async function dropTables(pool: Pool, prefix = PREFIX, schema = "public") {
  for (const table of TABLES)
    await pool.query(`DROP TABLE IF EXISTS "${schema}"."${prefix}${table}"`);
}

async function count(pool: Pool, table: string, where = "true", values: unknown[] = []) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM "${PREFIX}${table}" WHERE ${where}`,
    values,
  );
  return (rows[0] as { n: number }).n;
}

for (const target of targets) {
  const connected = await connectOrSkip(target.label, target.envVar, () =>
    openPool(target.url, target.ssl),
  );

  describe.skipIf(!connected)(target.label, () => {
    const pool = connected as Pool;
    const adapter = (options: { prefix?: string; schema?: string } = {}) =>
      postgresAdapter(pool, { prefix: PREFIX, ...options });

    beforeAll(async () => {
      await dropTables(pool);
      for (const statement of postgresSchemaStatements(PREFIX)) await pool.query(statement);
    });

    afterAll(async () => {
      await dropTables(pool);
      await pool.end();
    });

    // Deleting every role and permission cascades through all link tables.
    async function reset() {
      await pool.query(`DELETE FROM "${PREFIX}roles"`);
      await pool.query(`DELETE FROM "${PREFIX}permissions"`);
    }

    runAdapterContract(target.label, async () => {
      await reset();
      return adapter();
    });

    describe("Postgres specifics", () => {
      beforeEach(reset);

      it("schema is idempotent", async () => {
        for (const statement of postgresSchemaStatements(PREFIX)) await pool.query(statement);
      });

      if (target.ssl) {
        it("runs over SSL", async () => {
          const { rows } = await pool.query(
            "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
          );
          expect(rows).toEqual([{ ssl: true }]);
          await adapter().createRoles(["over-ssl"]);
          expect(await adapter().listRoles()).toEqual(["over-ssl"]);
        });
      }

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
        await adapter().createRoles(["rôle-ünïcode"]);
        expect(await adapter().listRoles()).toEqual(["rôle-ünïcode"]);
      });

      it("does not depend on search_path", async () => {
        const elsewhere = await openPool(target.url, target.ssl, {
          max: 1,
          options: "-c search_path=nowhere_at_all",
        });
        try {
          const db = postgresAdapter(elsewhere, { prefix: PREFIX });
          await db.createRoles(["found-anyway"]);
          expect(await db.listRoles()).toEqual(["found-anyway"]);
        } finally {
          await elsewhere.end();
        }
      });

      it("uses the schema option, quoted (case-sensitive)", async () => {
        await pool.query(`DROP SCHEMA IF EXISTS "Permly_S" CASCADE`);
        await pool.query(`CREATE SCHEMA "Permly_S"`);
        try {
          for (const statement of postgresSchemaStatements("x_", "Permly_S")) {
            await pool.query(statement);
          }
          const db = postgresAdapter(pool, { prefix: "x_", schema: "Permly_S" });
          await db.createRoles(["in-schema"]);
          expect(await db.listRoles()).toEqual(["in-schema"]);
          const { rows } = await pool.query(`SELECT name FROM "Permly_S"."x_roles"`);
          expect(rows).toEqual([{ name: "in-schema" }]);
        } finally {
          await pool.query(`DROP SCHEMA "Permly_S" CASCADE`);
        }
      });

      it("explains a missing schema or missing tables", async () => {
        const missingSchema = postgresAdapter(pool, { schema: "no_such_schema" });
        await expect(missingSchema.listRoles()).rejects.toThrow(
          `permly's tables were not found in schema "no_such_schema". Create them with: npx permly migrate --schema no_such_schema`,
        );
        const missingTables = postgresAdapter(pool, { prefix: "nothing_here_" });
        await expect(missingTables.listRoles()).rejects.toMatchObject({ code: "42P01" });
      });

      it("handles large lists in one statement (no chunking needed)", async () => {
        const db = adapter();
        const many = Array.from({ length: 5000 }, (_, i) => `p.n${i}`);
        await db.createRoles(["big"]);
        await db.createPermissions(many);
        await db.addRolePermissions("big", many);
        expect((await db.getRolePermissions("big")).length).toBe(5000);
        await db.setRolePermissions("big", many.slice(0, 4000));
        expect((await db.getRolePermissions("big")).length).toBe(4000);
        await db.removeRolePermissions("big", many);
        expect(await db.getRolePermissions("big")).toEqual([]);
        await db.addUserPermissions("1", many);
        expect((await db.getUserAccess("1")).directPermissions.length).toBe(5000);
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
        expect(await count(pool, "user_roles", "user_id = $1", ["u-1"])).toBe(2);
        expect(await count(pool, "user_permissions", "user_id = $1", ["u-1"])).toBe(1);
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
          const results = await Promise.allSettled(
            Array.from({ length: 20 }, (_, i) =>
              i % 2 === 0
                ? perms.user("u-2").syncRoles(options[i % 4] ?? [])
                : perms.role("a").syncPermissions(i % 4 === 1 ? ["x.one"] : ["x.two", "x.three"]),
            ),
          );
          expect(results.filter((r) => r.status === "rejected")).toEqual([]);
          const roles = await perms.user("u-2").getRoles();
          expect(options.map((o) => o.join())).toContain(roles.join());
          expect(await count(pool, "user_roles", "user_id = $1", ["u-2"])).toBe(roles.length);
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

      it("returns clients to the pool unchanged (no lock_timeout, no advisory locks)", async () => {
        const single = await openPool(target.url, target.ssl, { max: 1 });
        try {
          const db = postgresAdapter(single, { prefix: PREFIX });
          await db.createRoles(["a"]);
          const pid = (await single.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          await db.setUserRoles("iso", ["a"]);
          await db.setRolePermissions("a", []);
          const client = await single.connect();
          try {
            expect((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid).toBe(pid);
            expect((await client.query("SHOW lock_timeout")).rows[0].lock_timeout).toBe("0");
            const locks = await client.query(
              "SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = $1",
              [pid],
            );
            expect(locks.rows[0].n).toBe(0);
            expect(
              (await client.query("SELECT txid_current_if_assigned() AS t")).rows[0].t,
            ).toBeNull();
          } finally {
            client.release();
          }
        } finally {
          await single.end();
        }
      });

      it("never uses named (prepared) statements, for PgBouncer transaction mode", async () => {
        const configs: Record<string, unknown>[] = [];
        const record = <T extends { query: (c: never) => unknown }>(target: T): T =>
          new Proxy(target, {
            get(object, key, receiver) {
              const value = Reflect.get(object, key, receiver);
              if (key === "query") {
                return (config: Record<string, unknown>) => {
                  configs.push(config);
                  return (value as (c: unknown) => unknown).call(object, config);
                };
              }
              return typeof value === "function" ? value.bind(object) : value;
            },
          });
        const recordingPool = {
          query: (config: Record<string, unknown>) => {
            configs.push(config);
            return pool.query(config as unknown as pg.QueryConfig);
          },
          connect: async () => record(await pool.connect()),
        };
        const perms = createPermissions({
          adapter: postgresAdapter(recordingPool as never, { prefix: PREFIX }),
          cache: false,
          roles: ["a"],
          permissions: ["x.one"],
        });
        await perms.sync();
        await perms.role("a").syncPermissions(["x.one"]);
        await perms.user(1).syncRoles(["a"]);
        await perms.user(1).can("x.one");
        expect(configs.length).toBeGreaterThan(5);
        expect(configs.filter((config) => "name" in config)).toEqual([]);
      });

      it("getUserAccess is one query using indexes on the link tables", async () => {
        const db = adapter();
        const roles = Array.from({ length: 30 }, (_, i) => `role${i}`);
        const permissions = Array.from({ length: 200 }, (_, i) => `perm.n${i}`);
        await db.createRoles(roles);
        await db.createPermissions(permissions);
        for (const [i, role] of roles.entries()) {
          await db.addRolePermissions(role, permissions.slice(i * 5, i * 5 + 20));
        }
        // 2,000 users with one role and one direct permission each.
        await pool.query(
          `INSERT INTO "${PREFIX}user_roles" (user_id, role_id)
           SELECT 'user' || g, (SELECT MIN(id) FROM "${PREFIX}roles") + g % 30
           FROM generate_series(0, 1999) g`,
        );
        await pool.query(
          `INSERT INTO "${PREFIX}user_permissions" (user_id, permission_id)
           SELECT 'user' || g, (SELECT MIN(id) FROM "${PREFIX}permissions") + g % 200
           FROM generate_series(0, 1999) g`,
        );
        for (const table of TABLES) await pool.query(`ANALYZE "${PREFIX}${table}"`);

        const sent: { text: string; values: unknown[] }[] = [];
        const recording = {
          query: (config: { text: string; values: unknown[] }) => {
            sent.push(config);
            return pool.query(config);
          },
          connect: () => pool.connect(),
        };
        const access = await postgresAdapter(recording as never, { prefix: PREFIX }).getUserAccess(
          "user7",
        );
        expect(access.roles).toEqual(["role7"]);
        expect(sent).toHaveLength(1);
        const [only] = sent;
        if (!only) return;

        const { rows } = await pool.query(`EXPLAIN (FORMAT JSON) ${only.text}`, only.values);
        const nodes: { type: string; relation?: string; index?: string }[] = [];
        const walk = (node: Record<string, unknown>) => {
          nodes.push({
            type: String(node["Node Type"]),
            ...(node["Relation Name"] ? { relation: String(node["Relation Name"]) } : {}),
            ...(node["Index Name"] ? { index: String(node["Index Name"]) } : {}),
          });
          for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? [])
            walk(child);
        };
        const [explained] = rows[0]["QUERY PLAN"] as { Plan: Record<string, unknown> }[];
        if (!explained) throw new Error("EXPLAIN returned no plan");
        walk(explained.Plan);

        const scans = nodes.filter((node) => node.relation);
        if (process.env.PERMLY_EXPLAIN === "1") {
          process.stderr.write(
            `${target.label} EXPLAIN: ${scans.map((n) => `${n.relation}:${n.type}${n.index ? `(${n.index})` : ""}`).join("  ")}\n`,
          );
        }
        const linkTables = ["user_roles", "user_permissions", "role_permissions"].map(
          (table) => PREFIX + table,
        );
        for (const scan of scans.filter((node) => linkTables.includes(node.relation ?? ""))) {
          expect(scan.type, `${scan.relation} is sequentially scanned`).not.toBe("Seq Scan");
        }
        // user_roles appears in two UNION branches: 4 link-table scans, all through an index.
        expect(scans.filter((node) => linkTables.includes(node.relation ?? ""))).toHaveLength(4);
      });
    });
  });
}

describe("postgresAdapter input checks (no database needed)", () => {
  it("rejects a single Client, a checked-out client and non-pools", async () => {
    expect(() => postgresAdapter(new pg.Client() as never)).toThrow("got a single pg Client");
    expect(() =>
      postgresAdapter({
        query: async () => ({ rows: [] }),
        connect: async () => {},
        release() {},
      } as never),
    ).toThrow("got a client checked out of a pool");
    expect(() => postgresAdapter({ query() {} } as never)).toThrow("expects a pg Pool");
    const pool = new pg.Pool();
    expect(() => postgresAdapter(pool)).not.toThrow();
    await pool.end();
  });

  it.each([
    [{ prefix: "perm-" }],
    [{ prefix: 'x"; DROP TABLE users; --' }],
    [{ schema: "public; DROP" }],
    [{ schema: "" }],
    [{ schema: "a".repeat(64) }],
  ])("rejects unsafe option %j", async (options) => {
    const pool = new pg.Pool();
    expect(() => postgresAdapter(pool, options)).toThrow(InvalidInputError);
    await pool.end();
  });

  it("builds the schema from one place, schema-qualified and quoted", () => {
    const sql = postgresSchema("app_", "Tenant1");
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "Tenant1"."app_roles"`);
    expect(sql).toContain(`INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`);
    expect(sql).toContain(`REFERENCES "Tenant1"."app_roles" ("id") ON DELETE CASCADE`);
    expect(sql).toContain(`"team_id" VARCHAR(64) NOT NULL DEFAULT ''`);
    expect(sql).toContain(`CREATE INDEX IF NOT EXISTS "app_ur_role_idx"`);
    expect(sql).not.toContain("perm_");
    expect(sql).not.toMatch(/citext/i);
    expect(postgresSchema()).toContain(`"public"."perm_roles"`);
  });

  it("derives distinct 64-bit lock keys per schema, prefix and user", () => {
    const key = userLockKey("public", "perm_", "1");
    expect(BigInt(key) >= -(2n ** 63n) && BigInt(key) < 2n ** 63n).toBe(true);
    expect(userLockKey("public", "perm_", "2")).not.toBe(key);
    expect(userLockKey("other", "perm_", "1")).not.toBe(key);
    expect(userLockKey("public", "x_", "1")).not.toBe(key);
    expect(userLockKey("public", "perm_", "u".repeat(64))).toMatch(/^-?\d+$/);
  });
});

describe("postgresAdapter transactions (fake pool)", () => {
  function fakePool(failures: { code: string }[], rollbackFails = false) {
    const log: string[] = [];
    const released: unknown[] = [];
    const client = {
      query: async ({ text, values }: { text: string; values: unknown[] }) => {
        if (text === "BEGIN" || text === "COMMIT") {
          log.push(text.toLowerCase());
          return { rows: [] };
        }
        if (text === "ROLLBACK") {
          log.push("rollback");
          if (rollbackFails) throw new Error("connection lost");
          return { rows: [] };
        }
        if (text.startsWith("SET LOCAL lock_timeout")) {
          log.push("lock-timeout");
          return { rows: [] };
        }
        if (text.includes("pg_advisory_xact_lock")) {
          log.push(`advisory:${String(values[0]).length > 0}`);
          return { rows: [] };
        }
        if (text.includes("FOR UPDATE")) {
          log.push("lock-role");
          return { rows: [{ id: 1 }] };
        }
        const failure = failures.shift();
        if (failure) {
          log.push(`fail:${failure.code}`);
          throw Object.assign(new Error(failure.code), failure);
        }
        log.push("query");
        return { rows: [] };
      },
      release: (err?: unknown) => {
        log.push("release");
        released.push(err);
      },
    };
    return { log, released, pool: { query: client.query, connect: async () => client } };
  }

  it("setUserRoles: advisory lock inside the transaction, client released", async () => {
    const { pool, log, released } = fakePool([]);
    await postgresAdapter(pool).setUserRoles("1", ["a"]);
    expect(log).toEqual([
      "begin",
      "lock-timeout",
      "advisory:true",
      "query",
      "query",
      "commit",
      "release",
    ]);
    expect(released).toEqual([undefined]);
  });

  it("setRolePermissions locks the role row", async () => {
    const { pool, log } = fakePool([]);
    await postgresAdapter(pool).setRolePermissions("r", ["p"]);
    expect(log).toEqual([
      "begin",
      "lock-timeout",
      "lock-role",
      "query",
      "query",
      "commit",
      "release",
    ]);
  });

  it.each(["40P01", "40001"])("retries once on %s and releases both clients", async (code) => {
    const { pool, log } = fakePool([{ code }]);
    await postgresAdapter(pool).setUserRoles("1", ["a"]);
    expect(log.filter((l) => l === "release")).toHaveLength(2);
    expect(log.filter((l) => l === "rollback")).toHaveLength(1);
    expect(log.at(-2)).toBe("commit");
  });

  it("gives up after one retry", async () => {
    const { pool, log } = fakePool([{ code: "40P01" }, { code: "40001" }]);
    await expect(postgresAdapter(pool).setRolePermissions("r", ["p"])).rejects.toThrow("40001");
    expect(log.filter((l) => l === "release")).toHaveLength(2);
  });

  it("does not retry other errors, and still releases", async () => {
    const { pool, log } = fakePool([{ code: "23503" }]);
    await expect(postgresAdapter(pool).setUserRoles("1", ["a"])).rejects.toThrow("23503");
    expect(log.slice(-2)).toEqual(["rollback", "release"]);
    expect(log.filter((l) => l === "begin")).toHaveLength(1);
  });

  it("turns lock_timeout (55P03) into a PermissionsError LOCK_TIMEOUT, without retrying", async () => {
    const { pool, log } = fakePool([{ code: "55P03" }]);
    const error = await postgresAdapter(pool)
      .setUserRoles("1", ["a"])
      .catch((e: unknown) => e);
    expect(isPermissionsError(error)).toBe(true);
    expect(error).toMatchObject({ code: "LOCK_TIMEOUT" });
    expect(log.filter((l) => l === "begin")).toHaveLength(1);
    expect(log.at(-1)).toBe("release");
  });

  it("destroys a client whose ROLLBACK failed instead of reusing it", async () => {
    const { pool, released } = fakePool([{ code: "23503" }], true);
    await expect(postgresAdapter(pool).setUserRoles("1", ["a"])).rejects.toThrow("23503");
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
  });
});
