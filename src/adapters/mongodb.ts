import { randomUUID } from "node:crypto";
import { InvalidInputError, PermissionsError } from "../core/errors";
import type { PermissionAdapter, UserAccess } from "../core/types";
import { leaseKey } from "./mongodb-lock";
import { mongodbCollections, mongodbSetup } from "./mongodb-setup";
import { DEFAULT_PREFIX, validatePrefix } from "./sql-shared";

export { mongodbSetup } from "./mongodb-setup";
export type { MongoCollectionSpec, MongoIndexSpec } from "./mongodb-setup";

// Only the parts of the MongoDB driver used here. permly never imports mongodb or mongoose:
// it works with whatever the app already has.
type Doc = Record<string, unknown>;
interface Cursor {
  toArray(): Promise<Doc[]>;
}
interface Session {
  withTransaction(fn: () => Promise<unknown>): Promise<unknown>;
  endSession(): Promise<void>;
}
interface Collection {
  find(filter: Doc, options?: Doc): Cursor;
  findOne(filter: Doc, options?: Doc): Promise<Doc | null>;
  aggregate(pipeline: Doc[], options?: Doc): Cursor;
  bulkWrite(operations: Doc[], options?: Doc): Promise<unknown>;
  updateOne(filter: Doc, update: Doc, options?: Doc): Promise<unknown>;
  deleteOne(filter: Doc, options?: Doc): Promise<unknown>;
  deleteMany(filter: Doc, options?: Doc): Promise<unknown>;
  listIndexes(): Cursor;
}
interface MongoDb {
  databaseName: string;
  collection(name: string): Collection;
  admin(): { command(command: Doc): Promise<Doc> };
  client: { startSession(): Session };
}

export interface MongodbAdapterOptions {
  /** Collection name prefix. Letters, numbers and "_" only. Default "perm_". */
  prefix?: string;
}

const NO_TEAM = "";
const LOCK_WAIT_MS = 10_000;
const LEASE_MS = 10_000;

/**
 * Stores roles and permissions in MongoDB 7+. Pass a native `Db` (`client.db()`), a mongoose
 * Connection, or the mongoose default export.
 *
 * Works on standalone servers: syncRoles/syncPermissions are serialized with lease locks.
 * On replica sets and sharded clusters they additionally run in a transaction.
 */
export function mongodbAdapter(db: object, options: MongodbAdapterOptions = {}): PermissionAdapter {
  const getDb = resolveDb(db);
  const prefix = validatePrefix(options.prefix ?? DEFAULT_PREFIX);
  const c = mongodbCollections(prefix);
  const setup = mongodbSetup(prefix);

  let ready: Promise<void> | undefined;
  let transactional: Promise<boolean> | undefined;

  /** The Db, after checking once that the collections and indexes exist. */
  async function open(): Promise<MongoDb> {
    const database = getDb();
    ready ??= verifySetup(database).catch((error: unknown) => {
      ready = undefined; // a failed check (e.g. not migrated yet) is retried next time
      throw error;
    });
    await ready;
    return database;
  }

  async function verifySetup(database: MongoDb): Promise<void> {
    const missing: string[] = [];
    for (const spec of setup) {
      let existing: string[];
      try {
        existing = (await database.collection(spec.name).listIndexes().toArray()).map((index) =>
          String(index.name),
        );
      } catch (error) {
        if (codeOf(error) === 26) {
          missing.push(`collection ${spec.name}`); // NamespaceNotFound
          continue;
        }
        throw error;
      }
      for (const index of spec.indexes) {
        if (!existing.includes(index.name)) missing.push(`index ${spec.name}.${index.name}`);
      }
    }
    if (missing.length > 0) {
      const flag = prefix === DEFAULT_PREFIX ? "" : ` --prefix ${prefix}`;
      throw new Error(
        `permly's MongoDB collections or indexes are missing in "${database.databaseName}" ` +
          `(${missing.join(", ")}). Create them with: npx permly migrate${flag}`,
      );
    }
  }

  function isTransactional(database: MongoDb): Promise<boolean> {
    transactional ??= database
      .admin()
      .command({ hello: 1 })
      .then((hello) => typeof hello.setName === "string" || hello.msg === "isdbgrid")
      .catch((error: unknown) => {
        transactional = undefined;
        throw error;
      });
    return transactional;
  }

  const col = (database: MongoDb, name: string) => database.collection(name);
  const withSession = (session: Session | undefined, extra: Doc = {}) =>
    session ? { ...extra, session } : extra;

  async function idsByName(
    database: MongoDb,
    name: string,
    names: string[],
    session?: Session,
  ): Promise<unknown[]> {
    const docs = await col(database, name)
      .find({ name: { $in: names } }, withSession(session, { projection: { _id: 1 } }))
      .toArray();
    return docs.map((doc) => doc._id);
  }

  /** Upserts link documents; a duplicate key from a concurrent insert means "already there". */
  async function upsertLinks(
    database: MongoDb,
    name: string,
    links: Doc[],
    session?: Session,
  ): Promise<void> {
    if (links.length === 0) return;
    await ignoreDuplicateKeys(
      col(database, name).bulkWrite(
        links.map((link) => ({
          updateOne: { filter: link, update: { $setOnInsert: link }, upsert: true },
        })),
        withSession(session, { ordered: false }),
      ),
    );
  }

  async function createNamed(name: string, names: string[]): Promise<void> {
    if (names.length === 0) return;
    const database = await open();
    await ignoreDuplicateKeys(
      col(database, name).bulkWrite(
        names.map((value) => ({
          updateOne: {
            filter: { name: value },
            update: { $setOnInsert: { name: value, createdAt: new Date() } },
            upsert: true,
          },
        })),
        { ordered: false },
      ),
    );
  }

  /**
   * Lease lock: one document per key, taken if absent or expired. Waits up to 10s, then
   * LOCK_TIMEOUT. A crashed holder's lease expires after 10s and is taken over directly
   * (the TTL index only cleans up; it runs about once a minute).
   */
  async function withLease(database: MongoDb, key: string, fn: () => Promise<void>) {
    const locks = col(database, c.locks);
    const owner = randomUUID();
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      const now = Date.now();
      try {
        // Matches only an expired lease; if a live one exists, the upsert's insert hits the
        // unique _id and fails with a duplicate key, meaning "held by someone else".
        await locks.updateOne(
          { _id: key, expiresAt: { $lte: new Date(now) } },
          { $set: { owner, expiresAt: new Date(now + LEASE_MS) } },
          { upsert: true },
        );
        break;
      } catch (error) {
        if (!onlyDuplicateKeys(error)) throw error;
      }
      if (Date.now() >= deadline) {
        throw new PermissionsError(
          "LOCK_TIMEOUT",
          `Timed out after ${LOCK_WAIT_MS / 1000}s waiting for a lock held by another syncRoles() or syncPermissions().`,
        );
      }
      await sleep(25 + Math.random() * 50);
    }
    try {
      await fn();
    } finally {
      await locks.deleteOne({ _id: key, owner }).catch(() => {});
    }
  }

  /** Lease lock, plus a transaction when the deployment supports them. */
  async function exclusive(
    key: string,
    work: (database: MongoDb, session?: Session) => Promise<void>,
  ) {
    const database = await open();
    await withLease(database, key, async () => {
      if (!(await isTransactional(database))) return work(database);
      const session = database.client.startSession();
      try {
        await session.withTransaction(() => work(database, session));
      } finally {
        await session.endSession();
      }
    });
  }

  async function names(name: string): Promise<string[]> {
    const database = await open();
    const docs = await col(database, name)
      .find({}, { projection: { _id: 0, name: 1 } })
      .toArray();
    return docs.map((doc) => String(doc.name));
  }

  return {
    listRoles: () => names(c.roles),
    listPermissions: () => names(c.permissions),
    createRoles: (roles) => createNamed(c.roles, roles),
    createPermissions: (perms) => createNamed(c.permissions, perms),

    // The role goes first: if the process dies before its links are removed, they point to
    // nothing and every read ignores them. A re-created role gets a new _id, so they never
    // come back to life.
    async deleteRole(name) {
      const database = await open();
      const role = await col(database, c.roles).findOne({ name });
      if (!role) return;
      await col(database, c.roles).deleteOne({ _id: role._id });
      await col(database, c.rolePermissions).deleteMany({ role_id: role._id });
      await col(database, c.userRoles).deleteMany({ role_id: role._id });
    },

    async deletePermission(name) {
      const database = await open();
      const permission = await col(database, c.permissions).findOne({ name });
      if (!permission) return;
      await col(database, c.permissions).deleteOne({ _id: permission._id });
      await col(database, c.rolePermissions).deleteMany({ permission_id: permission._id });
      await col(database, c.userPermissions).deleteMany({ permission_id: permission._id });
    },

    async getRolePermissions(role) {
      const database = await open();
      const [doc] = await col(database, c.roles)
        .aggregate([
          { $match: { name: role } },
          lookup(c.rolePermissions, "_id", "role_id", "links"),
          lookup(c.permissions, "links.permission_id", "_id", "permissions"),
          { $project: { _id: 0, names: "$permissions.name" } },
        ])
        .toArray();
      return (doc?.names as string[] | undefined) ?? [];
    },

    async addRolePermissions(role, perms) {
      const database = await open();
      const [roleId] = await idsByName(database, c.roles, [role]);
      if (roleId === undefined) return;
      const permissionIds = await idsByName(database, c.permissions, perms);
      await upsertLinks(
        database,
        c.rolePermissions,
        permissionIds.map((permissionId) => ({ role_id: roleId, permission_id: permissionId })),
      );
    },

    async removeRolePermissions(role, perms) {
      const database = await open();
      const [roleId] = await idsByName(database, c.roles, [role]);
      if (roleId === undefined) return;
      const permissionIds = await idsByName(database, c.permissions, perms);
      await col(database, c.rolePermissions).deleteMany({
        role_id: roleId,
        permission_id: { $in: permissionIds },
      });
    },

    setRolePermissions: (role, perms) =>
      exclusive(leaseKey("role", role), async (database, session) => {
        const [roleId] = await idsByName(database, c.roles, [role], session);
        if (roleId === undefined) return;
        const permissionIds = await idsByName(database, c.permissions, perms, session);
        await col(database, c.rolePermissions).deleteMany(
          { role_id: roleId },
          withSession(session),
        );
        await upsertLinks(
          database,
          c.rolePermissions,
          permissionIds.map((permissionId) => ({ role_id: roleId, permission_id: permissionId })),
          session,
        );
      }),

    // One aggregation: the user's roles with their permissions, plus direct permissions.
    // $unwind drops links whose role or permission no longer exists (orphans).
    async getUserAccess(userId): Promise<UserAccess> {
      const database = await open();
      const rows = await col(database, c.userRoles)
        .aggregate([
          { $match: { user_id: userId, team_id: NO_TEAM } },
          lookup(c.roles, "role_id", "_id", "role"),
          { $unwind: "$role" },
          lookup(c.rolePermissions, "role_id", "role_id", "links"),
          lookup(c.permissions, "links.permission_id", "_id", "permissions"),
          {
            $project: {
              _id: 0,
              kind: "role",
              name: "$role.name",
              permissions: "$permissions.name",
            },
          },
          {
            $unionWith: {
              coll: c.userPermissions,
              pipeline: [
                { $match: { user_id: userId, team_id: NO_TEAM } },
                lookup(c.permissions, "permission_id", "_id", "permission"),
                { $unwind: "$permission" },
                { $project: { _id: 0, kind: "direct", name: "$permission.name" } },
              ],
            },
          },
        ])
        .toArray();
      const access: UserAccess = { roles: [], rolePermissions: [], directPermissions: [] };
      for (const row of rows) {
        if (row.kind === "role") {
          access.roles.push(String(row.name));
          access.rolePermissions.push(...((row.permissions as string[] | undefined) ?? []));
        } else {
          access.directPermissions.push(String(row.name));
        }
      }
      return access;
    },

    async addUserRoles(userId, roles) {
      const database = await open();
      const roleIds = await idsByName(database, c.roles, roles);
      await upsertLinks(
        database,
        c.userRoles,
        roleIds.map((roleId) => ({ user_id: userId, team_id: NO_TEAM, role_id: roleId })),
      );
    },

    async removeUserRoles(userId, roles) {
      const database = await open();
      const roleIds = await idsByName(database, c.roles, roles);
      await col(database, c.userRoles).deleteMany({
        user_id: userId,
        team_id: NO_TEAM,
        role_id: { $in: roleIds },
      });
    },

    setUserRoles: (userId, roles) =>
      exclusive(leaseKey("user", userId), async (database, session) => {
        const roleIds = await idsByName(database, c.roles, roles, session);
        await col(database, c.userRoles).deleteMany(
          { user_id: userId, team_id: NO_TEAM },
          withSession(session),
        );
        await upsertLinks(
          database,
          c.userRoles,
          roleIds.map((roleId) => ({ user_id: userId, team_id: NO_TEAM, role_id: roleId })),
          session,
        );
      }),

    async addUserPermissions(userId, perms) {
      const database = await open();
      const permissionIds = await idsByName(database, c.permissions, perms);
      await upsertLinks(
        database,
        c.userPermissions,
        permissionIds.map((permissionId) => ({
          user_id: userId,
          team_id: NO_TEAM,
          permission_id: permissionId,
        })),
      );
    },

    async removeUserPermissions(userId, perms) {
      const database = await open();
      const permissionIds = await idsByName(database, c.permissions, perms);
      await col(database, c.userPermissions).deleteMany({
        user_id: userId,
        team_id: NO_TEAM,
        permission_id: { $in: permissionIds },
      });
    },
  };
}

function lookup(from: string, localField: string, foreignField: string, as: string): Doc {
  return { $lookup: { from, localField, foreignField, as } };
}

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/** True if every write error is a duplicate key (E11000), e.g. two upserts racing. */
function onlyDuplicateKeys(error: unknown): boolean {
  const { writeErrors, writeConcernError } = (error ?? {}) as {
    writeErrors?: unknown;
    writeConcernError?: unknown;
  };
  if (writeConcernError) return false;
  const list = Array.isArray(writeErrors) ? writeErrors : writeErrors ? [writeErrors] : [];
  if (list.length > 0) return list.every((item) => codeOf(item) === 11000);
  return codeOf(error) === 11000;
}

async function ignoreDuplicateKeys(write: Promise<unknown>): Promise<void> {
  try {
    await write;
  } catch (error) {
    if (!onlyDuplicateKeys(error)) throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Accepts a native Db, a mongoose Connection or the mongoose default export. */
function resolveDb(input: unknown): () => MongoDb {
  const value = input as Record<string, unknown> | null;
  if (typeof value !== "object" || value === null) throw notSupported();

  // mongoose default export: use its default connection.
  const connection =
    isMongooseConnection(value.connection) && typeof value.connect === "function"
      ? (value.connection as Record<string, unknown>)
      : isMongooseConnection(value)
        ? value
        : undefined;
  if (connection) {
    // A mongoose connection only has .db once connected, so look it up on every use.
    return () => {
      const db = connection.db as MongoDb | undefined;
      if (!db) {
        throw new Error(
          "mongoose is not connected yet. Call `await mongoose.connect(url)` before using permly.",
        );
      }
      return db;
    };
  }

  if (typeof value.collection === "function" && typeof value.databaseName === "string") {
    const db = value as unknown as MongoDb;
    return () => db;
  }
  if (typeof value.db === "function" && typeof value.connect === "function") {
    throw new InvalidInputError(
      "mongodbAdapter() got a MongoClient. Pass a database instead: mongodbAdapter(client.db()).",
    );
  }
  throw notSupported();
}

function isMongooseConnection(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "readyState" in value &&
    typeof (value as { getClient?: unknown }).getClient === "function"
  );
}

function notSupported(): InvalidInputError {
  return new InvalidInputError(
    "mongodbAdapter() expects a MongoDB database (client.db()), a mongoose Connection, or mongoose itself.",
  );
}
