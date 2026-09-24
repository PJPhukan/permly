import { MongoClient, ObjectId, type Db } from "mongodb";
import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mongodbAdapter, mongodbSetup } from "../../src/adapters/mongodb";
import { leaseKey } from "../../src/adapters/mongodb-lock";
import { createPermissions } from "../../src/core/create-permissions";
import { InvalidInputError, isPermissionsError } from "../../src/core/errors";
import { runAdapterContract } from "./adapter-contract";
import { connectOrSkip } from "./db";

const PREFIX = "permly_test_";

const targets = [
  {
    label: "MongoDB 7",
    envVar: "PERMLY_MONGO7_URL",
    url: "mongodb://127.0.0.1:27107/permly",
    rs: false,
  },
  {
    label: "MongoDB 7 replica set",
    envVar: "PERMLY_MONGO7RS_URL",
    url: "mongodb://127.0.0.1:27117/permly?directConnection=true",
    rs: true,
  },
  {
    label: "MongoDB 8",
    envVar: "PERMLY_MONGO8_URL",
    url: "mongodb://127.0.0.1:27108/permly",
    rs: false,
  },
  {
    label: "MongoDB 8 replica set",
    envVar: "PERMLY_MONGO8RS_URL",
    url: "mongodb://127.0.0.1:27118/permly?directConnection=true",
    rs: true,
  },
].map((target) => ({ ...target, url: process.env[target.envVar] ?? target.url }));

/** What `npx permly migrate` does: create collections and indexes, idempotently. */
async function applySetup(db: Db, prefix = PREFIX) {
  for (const spec of mongodbSetup(prefix)) {
    await db.createCollection(spec.name).catch((error: { code?: number }) => {
      if (error.code !== 48) throw error; // NamespaceExists
    });
    await db.collection(spec.name).createIndexes(spec.indexes);
  }
}

async function dropAll(db: Db, prefix = PREFIX) {
  for (const spec of mongodbSetup(prefix))
    await db
      .collection(spec.name)
      .drop()
      .catch(() => {});
}

async function connect(url: string, options: ConstructorParameters<typeof MongoClient>[1] = {}) {
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 3000, ...options });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

let timeoutTested = false;

for (const target of targets) {
  const client = await connectOrSkip(target.label, target.envVar, () => connect(target.url));

  describe.skipIf(!client)(target.label, () => {
    const mongo = client as MongoClient;
    const db = mongo.db();
    const c = (name: string) => db.collection(PREFIX + name);
    const adapter = (prefix = PREFIX) => mongodbAdapter(db, { prefix });

    beforeAll(async () => {
      await dropAll(db);
      await applySetup(db);
    });

    afterAll(async () => {
      await dropAll(db);
      await mongo.close();
    });

    async function reset() {
      for (const spec of mongodbSetup(PREFIX)) await db.collection(spec.name).deleteMany({});
    }

    runAdapterContract(target.label, async () => {
      await reset();
      return adapter();
    });

    describe("MongoDB specifics", () => {
      beforeEach(reset);

      it("reports the deployment type we expect", async () => {
        const hello = await db.admin().command({ hello: 1 });
        expect(typeof hello.setName === "string").toBe(target.rs);
      });

      it("names and user ids are case-sensitive", async () => {
        const store = adapter();
        await store.createRoles(["Admin", "admin"]);
        expect((await store.listRoles()).sort()).toEqual(["Admin", "admin"]);
        await store.addUserRoles("abc", ["admin"]);
        expect((await store.getUserAccess("ABC")).roles).toEqual([]);
      });

      it("refuses to run without the collections and indexes, naming the fix", async () => {
        const missing = adapter("nothing_here_");
        await expect(missing.listRoles()).rejects.toThrow(
          `Create them with: npx permly migrate --prefix nothing_here_`,
        );
        await expect(missing.listRoles()).rejects.toThrow("collection nothing_here_roles");

        // The check is not cached as a failure: once migrated, the same adapter works.
        await applySetup(db, "nothing_here_");
        try {
          await missing.createRoles(["now-it-works"]);
          expect(await missing.listRoles()).toEqual(["now-it-works"]);
        } finally {
          await dropAll(db, "nothing_here_");
        }
      });

      it("detects a missing index too", async () => {
        await applySetup(db, "noindex_");
        await db.collection("noindex_user_roles").dropIndex("link_unique");
        try {
          await expect(adapter("noindex_").listRoles()).rejects.toThrow(
            "index noindex_user_roles.link_unique",
          );
        } finally {
          await dropAll(db, "noindex_");
        }
      });

      it("never creates collections or indexes itself", async () => {
        await adapter("never_created_")
          .listRoles()
          .catch(() => {});
        const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(
          (collection) => collection.name,
        );
        expect(names.filter((name) => name.startsWith("never_created_"))).toEqual([]);
      });

      it("works with a mongoose Connection and the mongoose default export", async () => {
        await adapter().createRoles(["from-native"]);

        const connection = await mongoose.createConnection(target.url).asPromise();
        const instance = new mongoose.Mongoose(); // behaves like `import mongoose from "mongoose"`
        try {
          expect(await mongodbAdapter(connection, { prefix: PREFIX }).listRoles()).toEqual([
            "from-native",
          ]);

          const early = mongodbAdapter(instance, { prefix: PREFIX });
          await expect(early.listRoles()).rejects.toThrow("mongoose is not connected yet");
          await instance.connect(target.url);
          expect(await early.listRoles()).toEqual(["from-native"]);
        } finally {
          await connection.close();
          await instance.disconnect();
        }
      });

      it("cascades deletes to the link collections", async () => {
        const store = adapter();
        await store.createRoles(["editor", "viewer"]);
        await store.createPermissions(["posts.edit", "posts.view"]);
        await store.addRolePermissions("editor", ["posts.edit", "posts.view"]);
        await store.addRolePermissions("viewer", ["posts.view"]);
        await store.addUserRoles("1", ["editor", "viewer"]);
        await store.addUserPermissions("1", ["posts.edit"]);

        await store.deleteRole("editor");
        expect(await c("user_roles").countDocuments()).toBe(1);
        expect(await c("role_permissions").countDocuments()).toBe(1);
        await store.deletePermission("posts.view");
        expect(await c("role_permissions").countDocuments()).toBe(0);
        await store.deletePermission("posts.edit");
        expect(await c("user_permissions").countDocuments()).toBe(0);
      });

      it("ignores orphaned links (e.g. a crash in the middle of a delete)", async () => {
        const store = adapter();
        await store.createRoles(["editor"]);
        await store.createPermissions(["posts.edit", "posts.view"]);
        await store.addRolePermissions("editor", ["posts.edit", "posts.view"]);
        await store.addUserRoles("1", ["editor"]);
        await store.addUserPermissions("1", ["posts.view"]);

        // Links pointing to documents that don't exist.
        const ghost = () => new ObjectId();
        await c("user_roles").insertOne({ user_id: "1", team_id: "", role_id: ghost() });
        await c("user_permissions").insertOne({
          user_id: "1",
          team_id: "",
          permission_id: ghost(),
        });
        const editor = await c("roles").findOne({ name: "editor" });
        await c("role_permissions").insertOne({ role_id: editor?._id, permission_id: ghost() });

        expect(await store.getUserAccess("1")).toEqual({
          roles: ["editor"],
          rolePermissions: expect.arrayContaining(["posts.edit", "posts.view"]),
          directPermissions: ["posts.view"],
        });
        expect((await store.getRolePermissions("editor")).sort()).toEqual([
          "posts.edit",
          "posts.view",
        ]);

        // Crash mid-deleteRole: the role document is gone but its links are not.
        await c("roles").deleteOne({ name: "editor" });
        expect((await store.getUserAccess("1")).roles).toEqual([]);
        expect((await store.getUserAccess("1")).rolePermissions).toEqual([]);

        // Re-creating the role must not bring the stale links back.
        await store.createRoles(["editor"]);
        expect((await store.getUserAccess("1")).roles).toEqual([]);
        expect(await store.getRolePermissions("editor")).toEqual([]);
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
        expect(await c("user_roles").countDocuments({ user_id: "u-1" })).toBe(2);
        expect(await c("user_permissions").countDocuments({ user_id: "u-1" })).toBe(1);
      });

      it("creates catalog entries idempotently under concurrency", async () => {
        const store = adapter();
        const results = await Promise.allSettled(
          Array.from({ length: 20 }, () => store.createRoles(["same", "other"])),
        );
        expect(results.filter((r) => r.status === "rejected")).toEqual([]);
        expect(await c("roles").countDocuments()).toBe(2);
      });

      it("handles parallel syncRoles / syncPermissions", async () => {
        const perms = createPermissions({
          adapter: adapter(),
          cache: false,
          roles: ["a", "b", "c"],
          permissions: ["x.one", "x.two", "x.three"],
        });
        await perms.sync();
        const options: ("a" | "b" | "c")[][] = [["a"], ["a", "b"], ["b", "c"], ["a", "b", "c"]];
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
          expect(await c("user_roles").countDocuments({ user_id: "u-2" })).toBe(roles.length);
          expect([["x.one"], ["x.three", "x.two"]].map((o) => o.join())).toContain(
            (await perms.role("a").getPermissions()).join(),
          );
        }
        expect(await c("locks").countDocuments()).toBe(0); // every lease released
      });

      it("concurrent setUserRoles on a new user never leaves a mix", async () => {
        const store = adapter();
        await store.createRoles(["a", "b", "c"]);
        const mixed: string[] = [];
        for (let i = 0; i < 50; i++) {
          const user = `fresh-${i}`;
          await Promise.all([
            store.setUserRoles(user, ["a"]),
            store.setUserRoles(user, ["b", "c"]),
          ]);
          const roles = (await store.getUserAccess(user)).roles.sort().join();
          if (roles !== "a" && roles !== "b,c") mixed.push(`${user}: ${roles}`);
        }
        expect(mixed).toEqual([]);
      });

      it("takes over the lease of a crashed holder once it expires", async () => {
        const store = adapter();
        await store.createRoles(["a"]);
        // A holder that died 1.5s into its lease: nobody will ever release it.
        await c("locks").insertOne({
          _id: leaseKey("user", "crashed") as unknown as ObjectId,
          owner: "dead-process",
          expiresAt: new Date(Date.now() + 1500),
        });
        const started = Date.now();
        await store.setUserRoles("crashed", ["a"]);
        expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
        expect((await store.getUserAccess("crashed")).roles).toEqual(["a"]);
        expect(await c("locks").countDocuments()).toBe(0);
      });

      it("takes an already-expired lease immediately", async () => {
        const store = adapter();
        await store.createRoles(["a"]);
        await c("locks").insertOne({
          _id: leaseKey("role", "a") as unknown as ObjectId,
          owner: "dead-process",
          expiresAt: new Date(Date.now() - 60_000),
        });
        const started = Date.now();
        await store.setRolePermissions("a", []);
        expect(Date.now() - started).toBeLessThan(1000);
      });

      // Takes 10 seconds, so it runs on the first reachable target only.
      if (!timeoutTested) {
        timeoutTested = true;
        it("gives up after 10s with LOCK_TIMEOUT", { timeout: 20_000 }, async () => {
          const store = adapter();
          await store.createRoles(["a"]);
          await c("locks").insertOne({
            _id: leaseKey("user", "stuck") as unknown as ObjectId,
            owner: "someone-else",
            expiresAt: new Date(Date.now() + 60_000),
          });
          const started = Date.now();
          const error = await store.setUserRoles("stuck", ["a"]).catch((e: unknown) => e);
          expect(isPermissionsError(error)).toBe(true);
          expect(error).toMatchObject({ code: "LOCK_TIMEOUT" });
          expect(Date.now() - started).toBeGreaterThanOrEqual(10_000);
          // The other holder's lock is untouched.
          expect(await c("locks").findOne({ owner: "someone-else" })).not.toBeNull();
        });
      }

      it(`${target.rs ? "uses" : "does not use"} a transaction for set* operations`, async () => {
        const monitored = await connect(target.url, { monitorCommands: true });
        const transactional: string[] = [];
        monitored.on("commandStarted", (event) => {
          if (event.command.autocommit === false) transactional.push(event.commandName);
        });
        try {
          const store = mongodbAdapter(monitored.db(), { prefix: PREFIX });
          await store.createRoles(["a"]);
          await store.setUserRoles("tx", ["a"]);
          if (target.rs)
            expect(transactional).toEqual(expect.arrayContaining(["delete", "update"]));
          else expect(transactional).toEqual([]);
        } finally {
          await monitored.close();
        }
      });

      it("getUserAccess is one aggregation that only uses indexes", async () => {
        const store = adapter();
        const roles = Array.from({ length: 30 }, (_, i) => `role${i}`);
        const permissions = Array.from({ length: 200 }, (_, i) => `perm.n${i}`);
        await store.createRoles(roles);
        await store.createPermissions(permissions);
        for (const [i, role] of roles.entries()) {
          await store.addRolePermissions(role, permissions.slice(i * 5, i * 5 + 20));
        }
        const roleDocs = await c("roles").find().sort({ name: 1 }).toArray();
        const permDocs = await c("permissions").find().toArray();
        await c("user_roles").insertMany(
          Array.from({ length: 2000 }, (_, u) => ({
            user_id: `user${u}`,
            team_id: "",
            role_id: roleDocs[u % roleDocs.length]?._id,
          })),
        );
        await c("user_permissions").insertMany(
          Array.from({ length: 2000 }, (_, u) => ({
            user_id: `user${u}`,
            team_id: "",
            permission_id: permDocs[u % permDocs.length]?._id,
          })),
        );

        const aggregations: { collection: string; pipeline: unknown[] }[] = [];
        const monitored = await connect(target.url, { monitorCommands: true });
        monitored.on("commandStarted", (event) => {
          if (event.commandName === "aggregate") {
            aggregations.push({
              collection: String(event.command.aggregate),
              pipeline: event.command.pipeline as unknown[],
            });
          }
        });
        try {
          const store2 = mongodbAdapter(monitored.db(), { prefix: PREFIX });
          await store2.listRoles(); // warm up (the one-time setup check is not an aggregation)
          aggregations.length = 0;
          const access = await store2.getUserAccess("user7");
          expect(access.roles.length).toBe(1);
          expect(aggregations).toHaveLength(1);
        } finally {
          await monitored.close();
        }

        const [only] = aggregations;
        if (!only) return;
        const plan = await db.command({
          explain: { aggregate: only.collection, pipeline: only.pipeline, cursor: {} },
          verbosity: "executionStats",
        });
        const text = JSON.stringify(plan);
        const found = (pattern: RegExp) => [...new Set(text.match(pattern) ?? [])];
        if (process.env.PERMLY_EXPLAIN === "1") {
          process.stderr.write(
            `${target.label} explain: ${[
              ...found(/"stage":"\w+"/g),
              ...found(/"indexesUsed":\[[^\]]*\]/g),
              ...found(/"collectionScans":\d+/g),
            ].join("  ")}\n`,
          );
        }
        // The $match uses the unique link index; every $lookup (roles, role_permissions,
        // permissions, and the $unionWith branch) reports its indexes and zero collection scans.
        expect(text).not.toContain("COLLSCAN");
        expect(text).not.toMatch(/"collectionScans":[1-9]/);
        expect(text).not.toMatch(/"strategy":"(NestedLoopJoin|HashJoin)"/);
        expect(found(/"collectionScans":\d+/g)).toEqual(['"collectionScans":0']);
        expect(text).toContain('"indexName":"link_unique"');
        expect(text).toContain('"indexesUsed":["_id_"]');
        expect(text).toContain('"indexesUsed":["link_unique"]');
      });
    });
  });
}

describe("mongodbAdapter input checks (no database needed)", () => {
  it("accepts a Db, a mongoose Connection and mongoose itself, without connecting", () => {
    const client = new MongoClient("mongodb://127.0.0.1:1/x");
    expect(() => mongodbAdapter(client.db())).not.toThrow();
    expect(() => mongodbAdapter(mongoose.createConnection())).not.toThrow();
    expect(() => mongodbAdapter(new mongoose.Mongoose())).not.toThrow();
  });

  it("rejects a MongoClient and other objects", () => {
    const client = new MongoClient("mongodb://127.0.0.1:1/x");
    expect(() => mongodbAdapter(client)).toThrow("got a MongoClient. Pass a database instead");
    expect(() => mongodbAdapter({})).toThrow(InvalidInputError);
    expect(() => mongodbAdapter(null as never)).toThrow("expects a MongoDB database");
  });

  it("rejects an unsafe prefix", () => {
    const client = new MongoClient("mongodb://127.0.0.1:1/x");
    expect(() => mongodbAdapter(client.db(), { prefix: "perm.$x" })).toThrow(InvalidInputError);
  });

  it("describes the collections and indexes in one place", () => {
    const setup = mongodbSetup("app_");
    expect(setup.map((spec) => spec.name)).toEqual([
      "app_roles",
      "app_permissions",
      "app_role_permissions",
      "app_user_roles",
      "app_user_permissions",
      "app_locks",
    ]);
    expect(setup[3]?.indexes[0]).toEqual({
      name: "link_unique",
      key: { user_id: 1, team_id: 1, role_id: 1 },
      unique: true,
    });
    expect(setup[5]?.indexes[0]).toMatchObject({ key: { expiresAt: 1 }, expireAfterSeconds: 0 });
    expect(JSON.stringify(setup)).not.toContain("collation");
  });
});
