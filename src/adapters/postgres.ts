import { createHash } from "node:crypto";
import { InvalidInputError, PermissionsError } from "../core/errors";
import type { PermissionAdapter, UserAccess } from "../core/types";
import { postgresTables } from "./postgres-schema";
import { retryOnce, validatePrefix, validateSchema } from "./sql-shared";

export { postgresSchema, postgresSchemaStatements } from "./postgres-schema";

// Only the parts of pg used here, so any pg-compatible pool works (pg, @neondatabase/serverless,
// ...) and permly's types don't depend on a specific pg version.
interface QueryConfig {
  text: string;
  values: unknown[];
}
interface Queryable {
  query(config: QueryConfig): Promise<{ rows: unknown[] }>;
}
export interface PgPoolClient extends Queryable {
  /** Passing an error tells pg the connection is broken and must not be reused. */
  release(err?: Error | boolean): void;
}
export interface PgPool extends Queryable {
  connect(): Promise<PgPoolClient>;
}

export interface PostgresAdapterOptions {
  /** Table name prefix. Letters, numbers and "_" only. Default "perm_". */
  prefix?: string;
  /** Schema holding the tables. Letters, numbers and "_" only. Default "public". */
  schema?: string;
}

type Row = Record<string, unknown>;

// 40P01 deadlock_detected, 40001 serialization_failure: transient, safe to run again.
const RETRYABLE_CODES = new Set(["40P01", "40001"]);
const LOCK_TIMEOUT = "10s";

function codeOf(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

function isRetryable(err: unknown): boolean {
  return RETRYABLE_CODES.has(codeOf(err) as string);
}

/**
 * Stores roles and permissions in Postgres 13+. Pass a `pg` Pool.
 * Works behind PgBouncer in transaction mode: only unnamed statements and
 * transaction-scoped settings and locks are used.
 */
export function postgresAdapter(
  pool: PgPool,
  options: PostgresAdapterOptions = {},
): PermissionAdapter {
  assertPool(pool);
  const prefix = validatePrefix(options.prefix);
  const schema = validateSchema(options.schema);
  const t = postgresTables(prefix, schema);
  // Only rows not tied to a team. team_id is reserved for future team support.
  const NO_TEAM = "''";

  async function query(sql: string, values: unknown[] = [], db: Queryable = pool): Promise<Row[]> {
    try {
      // No `name`: an unnamed statement, which PgBouncer's transaction mode supports.
      return (await db.query({ text: sql, values })).rows as Row[];
    } catch (err) {
      throw explain(err, schema, prefix);
    }
  }

  async function names(sql: string, values: unknown[] = []): Promise<string[]> {
    return (await query(sql, values)).map((row) => String(row.name));
  }

  /** Writes are idempotent, so a deadlocked statement can simply run again. */
  function write(sql: string, values: unknown[]): Promise<Row[]> {
    return retryOnce(() => query(sql, values), isRetryable);
  }

  /**
   * Runs `fn` in a transaction on one client from the pool, retried once as a whole on
   * deadlock or serialization failure. Lock waits give up after 10s (LOCK_TIMEOUT).
   * `SET LOCAL` and transaction-level advisory locks end with the transaction, so the client
   * goes back to the pool unchanged.
   */
  function transaction(fn: (db: Queryable) => Promise<void>, advisoryKey?: string): Promise<void> {
    return retryOnce(async () => {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await query("BEGIN", [], client);
        await query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`, [], client);
        if (advisoryKey !== undefined) {
          await query("SELECT pg_advisory_xact_lock($1::bigint)", [advisoryKey], client);
        }
        await fn(client);
        await query("COMMIT", [], client);
      } catch (err) {
        await client.query({ text: "ROLLBACK", values: [] }).catch((rollbackError: unknown) => {
          broken =
            rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        });
        throw err;
      } finally {
        // A client whose ROLLBACK failed is in an unknown state; pg destroys it instead of reusing it.
        client.release(broken);
      }
    }, isRetryable);
  }

  const insertRolePermissions = (db: Queryable, role: string, perms: string[]) =>
    query(
      `INSERT INTO ${t.rolePermissions} (role_id, permission_id)
       SELECT r.id, p.id FROM ${t.roles} r JOIN ${t.permissions} p ON p.name = ANY($2::text[])
       WHERE r.name = $1
       ON CONFLICT DO NOTHING`,
      [role, perms],
      db,
    );

  const insertUserRoles = (db: Queryable, userId: string, roles: string[]) =>
    query(
      `INSERT INTO ${t.userRoles} (user_id, team_id, role_id)
       SELECT $1, ${NO_TEAM}, r.id FROM ${t.roles} r WHERE r.name = ANY($2::text[])
       ON CONFLICT DO NOTHING`,
      [userId, roles],
      db,
    );

  return {
    listRoles: () => names(`SELECT name FROM ${t.roles}`),

    listPermissions: () => names(`SELECT name FROM ${t.permissions}`),

    async createRoles(roleNames) {
      await write(
        `INSERT INTO ${t.roles} (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING`,
        [roleNames],
      );
    },

    async createPermissions(permissionNames) {
      await write(
        `INSERT INTO ${t.permissions} (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING`,
        [permissionNames],
      );
    },

    // Foreign keys cascade the delete to every link table.
    async deleteRole(name) {
      await write(`DELETE FROM ${t.roles} WHERE name = $1`, [name]);
    },

    async deletePermission(name) {
      await write(`DELETE FROM ${t.permissions} WHERE name = $1`, [name]);
    },

    getRolePermissions: (role) =>
      names(
        `SELECT p.name FROM ${t.roles} r
         JOIN ${t.rolePermissions} rp ON rp.role_id = r.id
         JOIN ${t.permissions} p ON p.id = rp.permission_id
         WHERE r.name = $1`,
        [role],
      ),

    async addRolePermissions(role, perms) {
      await retryOnce(() => insertRolePermissions(pool, role, perms), isRetryable);
    },

    async removeRolePermissions(role, perms) {
      await write(
        `DELETE FROM ${t.rolePermissions} rp USING ${t.roles} r, ${t.permissions} p
         WHERE rp.role_id = r.id AND rp.permission_id = p.id
           AND r.name = $1 AND p.name = ANY($2::text[])`,
        [role, perms],
      );
    },

    async setRolePermissions(role, perms) {
      await transaction(async (db) => {
        // Locking the role row makes concurrent syncs of the same role queue up.
        const [locked] = await query(
          `SELECT id FROM ${t.roles} WHERE name = $1 FOR UPDATE`,
          [role],
          db,
        );
        if (!locked) return;
        await query(`DELETE FROM ${t.rolePermissions} WHERE role_id = $1`, [locked.id], db);
        await insertRolePermissions(db, role, perms);
      });
    },

    // One round trip: the user's roles, their roles' permissions, and direct permissions.
    async getUserAccess(userId): Promise<UserAccess> {
      const rows = await query(
        `SELECT 'role' AS kind, r.name FROM ${t.userRoles} ur
           JOIN ${t.roles} r ON r.id = ur.role_id
           WHERE ur.user_id = $1 AND ur.team_id = ${NO_TEAM}
         UNION ALL
         SELECT 'role_permission', p.name FROM ${t.userRoles} ur
           JOIN ${t.rolePermissions} rp ON rp.role_id = ur.role_id
           JOIN ${t.permissions} p ON p.id = rp.permission_id
           WHERE ur.user_id = $1 AND ur.team_id = ${NO_TEAM}
         UNION ALL
         SELECT 'direct', p.name FROM ${t.userPermissions} up
           JOIN ${t.permissions} p ON p.id = up.permission_id
           WHERE up.user_id = $1 AND up.team_id = ${NO_TEAM}`,
        [userId],
      );
      const access: UserAccess = { roles: [], rolePermissions: [], directPermissions: [] };
      for (const row of rows) {
        const name = String(row.name);
        if (row.kind === "role") access.roles.push(name);
        else if (row.kind === "role_permission") access.rolePermissions.push(name);
        else access.directPermissions.push(name);
      }
      return access;
    },

    async addUserRoles(userId, roles) {
      await retryOnce(() => insertUserRoles(pool, userId, roles), isRetryable);
    },

    async removeUserRoles(userId, roles) {
      await write(
        `DELETE FROM ${t.userRoles} ur USING ${t.roles} r
         WHERE ur.role_id = r.id AND ur.user_id = $1 AND ur.team_id = ${NO_TEAM}
           AND r.name = ANY($2::text[])`,
        [userId, roles],
      );
    },

    async setUserRoles(userId, roles) {
      // There is no user row to lock, and under READ COMMITTED two syncs for a user with no
      // roles would both delete nothing and both insert, leaving a mix. The advisory lock
      // makes them run one after the other; it is released at COMMIT/ROLLBACK.
      await transaction(
        async (db) => {
          await query(
            `DELETE FROM ${t.userRoles} WHERE user_id = $1 AND team_id = ${NO_TEAM}`,
            [userId],
            db,
          );
          await insertUserRoles(db, userId, roles);
        },
        userLockKey(schema, prefix, userId),
      );
    },

    async addUserPermissions(userId, perms) {
      await write(
        `INSERT INTO ${t.userPermissions} (user_id, team_id, permission_id)
         SELECT $1, ${NO_TEAM}, p.id FROM ${t.permissions} p WHERE p.name = ANY($2::text[])
         ON CONFLICT DO NOTHING`,
        [userId, perms],
      );
    },

    async removeUserPermissions(userId, perms) {
      await write(
        `DELETE FROM ${t.userPermissions} up USING ${t.permissions} p
         WHERE up.permission_id = p.id AND up.user_id = $1 AND up.team_id = ${NO_TEAM}
           AND p.name = ANY($2::text[])`,
        [userId, perms],
      );
    },
  };
}

/**
 * The 64-bit advisory lock key for one user's syncRoles, from a hash of schema, prefix and
 * user id. A collision would only make two users' syncs wait for each other.
 */
export function userLockKey(schema: string, prefix: string, userId: string): string {
  const digest = createHash("sha1").update(`permly:${schema}.${prefix}:${userId}`).digest();
  return digest.readBigInt64BE(0).toString();
}

/** Turns the errors people actually hit during setup into ones that say what to do. */
function explain(err: unknown, schema: string, prefix: string): unknown {
  const code = codeOf(err);
  const message = err instanceof Error ? err.message : String(err);
  if (code === "55P03") {
    return new PermissionsError(
      "LOCK_TIMEOUT",
      `Timed out after ${LOCK_TIMEOUT} waiting for a lock held by another syncRoles() or syncPermissions().`,
    );
  }
  if (code === "3F000" || code === "42P01") {
    const flags = `${schema === "public" ? "" : ` --schema ${schema}`}${prefix === "perm_" ? "" : ` --prefix ${prefix}`}`;
    return Object.assign(
      new Error(
        `${message}. permly's tables were not found in schema "${schema}". ` +
          `Create them with: npx permly migrate${flags} (the schema itself must already exist).`,
        { cause: err },
      ),
      { code },
    );
  }
  return err;
}

function assertPool(pool: unknown): asserts pool is PgPool {
  const candidate = pool as Partial<Record<string, unknown>> | null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.query !== "function" ||
    typeof candidate.connect !== "function"
  ) {
    throw new InvalidInputError(
      `postgresAdapter() expects a pg Pool, e.g. new Pool({ connectionString }) from "pg".`,
    );
  }
  if (typeof candidate.release === "function") {
    throw new InvalidInputError(
      `postgresAdapter() got a client checked out of a pool (pool.connect()). Pass the Pool itself.`,
    );
  }
  if ("connectionParameters" in candidate && !("totalCount" in candidate)) {
    throw new InvalidInputError(
      `postgresAdapter() got a single pg Client. Pass a Pool instead (it uses separate connections for transactions): new Pool({ connectionString }).`,
    );
  }
}
