import { InvalidInputError, PermissionsError } from "../core/errors";
import type { PermissionAdapter, UserAccess } from "../core/types";
import { mysqlTables } from "./mysql-schema";
import { userLockName } from "./mysql-lock";
import { chunk, placeholders, retryOnce, validatePrefix } from "./sql-shared";

export { mysqlSchema, mysqlSchemaStatements } from "./mysql-schema";

// Only the parts of mysql2/promise used here, so any compatible pool works and
// permly's types don't depend on a specific mysql2 version.
interface QueryOptions {
  sql: string;
  rowsAsArray?: boolean;
}
interface Queryable {
  query(options: QueryOptions, values?: unknown[]): Promise<[unknown, unknown]>;
}
export interface MySqlConnection extends Queryable {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}
export interface MySqlPool extends Queryable {
  getConnection(): Promise<MySqlConnection>;
}

export interface MySqlAdapterOptions {
  /** Table name prefix. Letters, numbers and "_" only. Default "perm_". */
  prefix?: string;
}

type Row = Record<string, unknown>;

// ER_CHECKREAD is MariaDB's "record has changed since last read" conflict: transient, like a deadlock.
const RETRYABLE_ERRORS = new Set(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "ER_CHECKREAD"]);
const USER_LOCK_TIMEOUT_SECONDS = 10;

function isRetryable(err: unknown): boolean {
  return RETRYABLE_ERRORS.has((err as { code?: unknown } | null)?.code as string);
}

/**
 * Stores roles and permissions in MySQL 8+ or MariaDB 10.5+.
 * Pass a pool from `mysql2/promise` (or `pool.promise()` of a callback pool).
 */
export function mysqlAdapter(
  pool: MySqlPool,
  options: MySqlAdapterOptions = {},
): PermissionAdapter {
  assertPromisePool(pool);
  const prefix = validatePrefix(options.prefix);
  const t = mysqlTables(prefix);
  // Only rows not tied to a team. team_id is reserved for future team support.
  const NO_TEAM = "''";

  async function query(sql: string, values: unknown[] = [], db: Queryable = pool): Promise<Row[]> {
    // rowsAsArray is forced off in case the pool was created with it on.
    const [rows] = await db.query({ sql, rowsAsArray: false }, values);
    return rows as Row[];
  }

  async function names(sql: string, values: unknown[]): Promise<string[]> {
    return (await query(sql, values)).map((row) => String(row.name));
  }

  /** Writes are idempotent, so a deadlocked statement can simply run again. */
  function write(sql: string, values: unknown[], db: Queryable = pool): Promise<Row[]> {
    return retryOnce(() => query(sql, values, db), isRetryable);
  }

  /**
   * Runs `fn` in a transaction on one connection; retried once as a whole on deadlock.
   * READ COMMITTED avoids the gap locks that make concurrent delete-then-insert deadlock
   * under the default REPEATABLE READ. It applies to this transaction only.
   *
   * With `lockName`, a named lock (GET_LOCK) is held from before the transaction starts until
   * after it commits, so transactions with the same name run one at a time.
   */
  function transaction(fn: (db: Queryable) => Promise<void>, lockName?: string): Promise<void> {
    return retryOnce(async () => {
      const connection = await pool.getConnection();
      let locked = false;
      let began = false;
      try {
        if (lockName !== undefined) {
          const [row] = await query(
            "SELECT GET_LOCK(?, ?) AS locked",
            [lockName, USER_LOCK_TIMEOUT_SECONDS],
            connection,
          );
          // 1 = acquired, 0 = timed out, NULL = error (e.g. the wait was killed).
          if (Number(row?.locked) !== 1) {
            throw new PermissionsError(
              "LOCK_TIMEOUT",
              `Timed out after ${USER_LOCK_TIMEOUT_SECONDS}s waiting for lock "${lockName}", held by another syncRoles() for the same user.`,
            );
          }
          locked = true;
        }
        await query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED", [], connection);
        await connection.beginTransaction();
        began = true;
        await fn(connection);
        await connection.commit();
      } catch (err) {
        if (began) await connection.rollback().catch(() => {});
        throw err;
      } finally {
        if (locked) {
          // Same connection that took the lock. If this fails the connection is broken, and
          // MySQL frees a broken connection's locks itself.
          await query("SELECT RELEASE_LOCK(?)", [lockName], connection).catch(() => {});
        }
        connection.release();
      }
    }, isRetryable);
  }

  // --- SQL for links, shared by add* and set* ---

  function insertRolePermissions(db: Queryable, role: string, perms: string[]) {
    return sequential(chunk(perms), (batch) =>
      query(
        `INSERT INTO ${t.rolePermissions} (role_id, permission_id)
         SELECT r.id, p.id FROM ${t.roles} r JOIN ${t.permissions} p
         WHERE r.name = ? AND p.name IN (${placeholders(batch.length)})
         ON DUPLICATE KEY UPDATE ${t.rolePermissions}.role_id = ${t.rolePermissions}.role_id`,
        [role, ...batch],
        db,
      ),
    );
  }

  function insertUserRoles(db: Queryable, userId: string, roles: string[]) {
    return sequential(chunk(roles), (batch) =>
      query(
        `INSERT INTO ${t.userRoles} (user_id, team_id, role_id)
         SELECT ?, ${NO_TEAM}, r.id FROM ${t.roles} r WHERE r.name IN (${placeholders(batch.length)})
         ON DUPLICATE KEY UPDATE ${t.userRoles}.role_id = ${t.userRoles}.role_id`,
        [userId, ...batch],
        db,
      ),
    );
  }

  return {
    listRoles: () => names(`SELECT name FROM ${t.roles}`, []),

    listPermissions: () => names(`SELECT name FROM ${t.permissions}`, []),

    async createRoles(roleNames) {
      await sequential(chunk(roleNames), (batch) =>
        write(
          `INSERT INTO ${t.roles} (name) VALUES ${batch.map(() => "(?)").join(", ")}
           ON DUPLICATE KEY UPDATE name = name`,
          batch,
        ),
      );
    },

    async createPermissions(permissionNames) {
      await sequential(chunk(permissionNames), (batch) =>
        write(
          `INSERT INTO ${t.permissions} (name) VALUES ${batch.map(() => "(?)").join(", ")}
           ON DUPLICATE KEY UPDATE name = name`,
          batch,
        ),
      );
    },

    // Foreign keys cascade the delete to every link table.
    async deleteRole(name) {
      await write(`DELETE FROM ${t.roles} WHERE name = ?`, [name]);
    },

    async deletePermission(name) {
      await write(`DELETE FROM ${t.permissions} WHERE name = ?`, [name]);
    },

    getRolePermissions: (role) =>
      names(
        `SELECT p.name FROM ${t.roles} r
         JOIN ${t.rolePermissions} rp ON rp.role_id = r.id
         JOIN ${t.permissions} p ON p.id = rp.permission_id
         WHERE r.name = ?`,
        [role],
      ),

    async addRolePermissions(role, perms) {
      await retryOnce(() => insertRolePermissions(pool, role, perms), isRetryable);
    },

    async removeRolePermissions(role, perms) {
      await sequential(chunk(perms), (batch) =>
        write(
          `DELETE rp FROM ${t.rolePermissions} rp
           JOIN ${t.roles} r ON r.id = rp.role_id
           JOIN ${t.permissions} p ON p.id = rp.permission_id
           WHERE r.name = ? AND p.name IN (${placeholders(batch.length)})`,
          [role, ...batch],
        ),
      );
    },

    async setRolePermissions(role, perms) {
      await transaction(async (db) => {
        // Locking the role row makes concurrent syncs of the same role queue up.
        const [locked] = await query(
          `SELECT id FROM ${t.roles} WHERE name = ? FOR UPDATE`,
          [role],
          db,
        );
        if (!locked) return;
        await query(`DELETE FROM ${t.rolePermissions} WHERE role_id = ?`, [locked.id], db);
        await insertRolePermissions(db, role, perms);
      });
    },

    // One round trip: the user's roles, their roles' permissions, and direct permissions.
    async getUserAccess(userId): Promise<UserAccess> {
      const rows = await query(
        `SELECT 'role' AS kind, r.name FROM ${t.userRoles} ur
           JOIN ${t.roles} r ON r.id = ur.role_id
           WHERE ur.user_id = ? AND ur.team_id = ${NO_TEAM}
         UNION ALL
         SELECT 'role_permission', p.name FROM ${t.userRoles} ur
           JOIN ${t.rolePermissions} rp ON rp.role_id = ur.role_id
           JOIN ${t.permissions} p ON p.id = rp.permission_id
           WHERE ur.user_id = ? AND ur.team_id = ${NO_TEAM}
         UNION ALL
         SELECT 'direct', p.name FROM ${t.userPermissions} up
           JOIN ${t.permissions} p ON p.id = up.permission_id
           WHERE up.user_id = ? AND up.team_id = ${NO_TEAM}`,
        [userId, userId, userId],
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
      await sequential(chunk(roles), (batch) =>
        write(
          `DELETE ur FROM ${t.userRoles} ur JOIN ${t.roles} r ON r.id = ur.role_id
           WHERE ur.user_id = ? AND ur.team_id = ${NO_TEAM} AND r.name IN (${placeholders(batch.length)})`,
          [userId, ...batch],
        ),
      );
    },

    async setUserRoles(userId, roles) {
      // There is no user row to lock, and under READ COMMITTED two syncs for a user with no
      // roles would both delete nothing and both insert, leaving a mix. The named lock
      // makes them run one after the other instead.
      await transaction(
        async (db) => {
          await query(
            `DELETE FROM ${t.userRoles} WHERE user_id = ? AND team_id = ${NO_TEAM}`,
            [userId],
            db,
          );
          await insertUserRoles(db, userId, roles);
        },
        userLockName(prefix, userId),
      );
    },

    async addUserPermissions(userId, perms) {
      await sequential(chunk(perms), (batch) =>
        write(
          `INSERT INTO ${t.userPermissions} (user_id, team_id, permission_id)
           SELECT ?, ${NO_TEAM}, p.id FROM ${t.permissions} p WHERE p.name IN (${placeholders(batch.length)})
           ON DUPLICATE KEY UPDATE ${t.userPermissions}.permission_id = ${t.userPermissions}.permission_id`,
          [userId, ...batch],
        ),
      );
    },

    async removeUserPermissions(userId, perms) {
      await sequential(chunk(perms), (batch) =>
        write(
          `DELETE up FROM ${t.userPermissions} up JOIN ${t.permissions} p ON p.id = up.permission_id
           WHERE up.user_id = ? AND up.team_id = ${NO_TEAM} AND p.name IN (${placeholders(batch.length)})`,
          [userId, ...batch],
        ),
      );
    },
  };
}

async function sequential<T>(items: T[], fn: (item: T) => Promise<unknown>): Promise<void> {
  for (const item of items) await fn(item);
}

function assertPromisePool(pool: unknown): asserts pool is MySqlPool {
  const candidate = pool as Partial<Record<string, unknown>> | null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.query !== "function"
  ) {
    throw new InvalidInputError(
      `mysqlAdapter() expects a mysql2 pool, e.g. createPool() from "mysql2/promise".`,
    );
  }
  if (typeof candidate.promise === "function") {
    throw new InvalidInputError(
      `mysqlAdapter() got a callback-style mysql2 pool. Pass pool.promise(), or create the pool with "mysql2/promise".`,
    );
  }
  if (typeof candidate.getConnection !== "function") {
    throw new InvalidInputError(
      `mysqlAdapter() needs a pool (it uses separate connections for transactions), not a single connection. Use createPool() from "mysql2/promise".`,
    );
  }
}
