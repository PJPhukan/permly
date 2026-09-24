import { beforeEach, describe, expect, it } from "vitest";
import type { PermissionAdapter } from "../../src/core/types";

/**
 * Behaviour every adapter must share. Each adapter's test file calls this with a factory
 * that returns an adapter backed by empty storage.
 */
export function runAdapterContract(name: string, makeAdapter: () => Promise<PermissionAdapter>) {
  describe(`${name} adapter contract`, () => {
    let db: PermissionAdapter;
    const sorted = async (p: Promise<string[]>) => (await p).sort();

    beforeEach(async () => {
      db = await makeAdapter();
      await db.createRoles(["admin", "editor"]);
      await db.createPermissions(["posts.create", "posts.edit", "posts.delete", "posts.*"]);
    });

    it("lists created roles and permissions", async () => {
      expect(await sorted(db.listRoles())).toEqual(["admin", "editor"]);
      expect(await sorted(db.listPermissions())).toEqual([
        "posts.*",
        "posts.create",
        "posts.delete",
        "posts.edit",
      ]);
    });

    it("creates idempotently", async () => {
      await db.createRoles(["admin", "viewer"]);
      await db.createPermissions(["posts.edit"]);
      expect(await sorted(db.listRoles())).toEqual(["admin", "editor", "viewer"]);
      expect((await db.listPermissions()).length).toBe(4);
    });

    it("adds, removes and sets role permissions", async () => {
      await db.addRolePermissions("editor", ["posts.create", "posts.edit"]);
      await db.addRolePermissions("editor", ["posts.edit"]);
      expect(await sorted(db.getRolePermissions("editor"))).toEqual(["posts.create", "posts.edit"]);

      await db.removeRolePermissions("editor", ["posts.create"]);
      expect(await db.getRolePermissions("editor")).toEqual(["posts.edit"]);

      await db.setRolePermissions("editor", ["posts.delete", "posts.*"]);
      expect(await sorted(db.getRolePermissions("editor"))).toEqual(["posts.*", "posts.delete"]);

      await db.setRolePermissions("editor", []);
      expect(await db.getRolePermissions("editor")).toEqual([]);
    });

    it("returns empty access for an unknown user", async () => {
      expect(await db.getUserAccess("nobody")).toEqual({
        roles: [],
        rolePermissions: [],
        directPermissions: [],
      });
    });

    it("adds, removes and sets user roles", async () => {
      await db.addUserRoles("1", ["admin", "editor"]);
      await db.addUserRoles("1", ["admin"]);
      expect((await db.getUserAccess("1")).roles.sort()).toEqual(["admin", "editor"]);

      await db.removeUserRoles("1", ["admin"]);
      expect((await db.getUserAccess("1")).roles).toEqual(["editor"]);

      await db.setUserRoles("1", ["admin"]);
      expect((await db.getUserAccess("1")).roles).toEqual(["admin"]);

      await db.setUserRoles("1", []);
      expect((await db.getUserAccess("1")).roles).toEqual([]);
    });

    it("returns role and direct permissions for a user", async () => {
      await db.addRolePermissions("editor", ["posts.create", "posts.edit"]);
      await db.addRolePermissions("admin", ["posts.*"]);
      await db.addUserRoles("u-1", ["editor", "admin"]);
      await db.addUserPermissions("u-1", ["posts.delete"]);

      const access = await db.getUserAccess("u-1");
      expect([...new Set(access.rolePermissions)].sort()).toEqual([
        "posts.*",
        "posts.create",
        "posts.edit",
      ]);
      expect(access.directPermissions).toEqual(["posts.delete"]);

      await db.removeUserPermissions("u-1", ["posts.delete"]);
      expect((await db.getUserAccess("u-1")).directPermissions).toEqual([]);
    });

    it("keeps users separate", async () => {
      await db.addUserRoles("1", ["admin"]);
      await db.addUserPermissions("2", ["posts.edit"]);
      expect((await db.getUserAccess("2")).roles).toEqual([]);
      expect((await db.getUserAccess("1")).directPermissions).toEqual([]);
    });

    it("cascades role deletion to users", async () => {
      await db.addUserRoles("1", ["admin", "editor"]);
      await db.deleteRole("admin");
      expect(await db.listRoles()).toEqual(["editor"]);
      expect((await db.getUserAccess("1")).roles).toEqual(["editor"]);
    });

    it("cascades permission deletion to roles and users", async () => {
      await db.addRolePermissions("editor", ["posts.edit", "posts.create"]);
      await db.addUserPermissions("1", ["posts.edit"]);
      await db.deletePermission("posts.edit");
      expect(await db.getRolePermissions("editor")).toEqual(["posts.create"]);
      expect((await db.getUserAccess("1")).directPermissions).toEqual([]);
    });

    it("ignores unknown names in links", async () => {
      await db.addUserRoles("1", ["ghost"]);
      await db.addRolePermissions("editor", ["ghost.perm"]);
      await db.addUserPermissions("1", ["ghost.perm"]);
      expect(await db.getUserAccess("1")).toEqual({
        roles: [],
        rolePermissions: [],
        directPermissions: [],
      });
    });

    /**
     * Runs `sync` while reading as fast as possible, then checks every read against the fail-
     * closed rule: a read may show fewer names, never extra ones. Precisely:
     * - nothing outside old ∪ new is ever seen,
     * - no single read has both a name being removed and a name being added, and
     * - a name that is being removed (in old, not in new) never comes back once a read has
     *   seen it gone.
     */
    async function sampleDuringSync(
      oldList: string[],
      newList: string[],
      sync: () => Promise<void>,
      read: () => Promise<string[]>,
    ) {
      let done = false;
      const samples: string[][] = [];
      const reading = (async () => {
        while (!done) {
          samples.push(await read());
          await new Promise((resolve) => setImmediate(resolve)); // let the sync progress
        }
      })();
      await sync();
      done = true;
      await reading;
      samples.push(await read());

      const allowed = new Set([...oldList, ...newList]);
      const removing = oldList.filter((name) => !newList.includes(name));
      const adding = newList.filter((name) => !oldList.includes(name));
      for (const sample of samples) {
        expect(sample.filter((name) => !allowed.has(name))).toEqual([]);
        // Never old-only and new-only names together: that would be more than either list.
        const both =
          sample.some((n) => removing.includes(n)) && sample.some((n) => adding.includes(n));
        expect(both, `read saw removed and added names together: ${sample.join(",")}`).toBe(false);
      }
      for (const removed of oldList.filter((name) => !newList.includes(name))) {
        const goneAt = samples.findIndex((sample) => !sample.includes(removed));
        if (goneAt === -1) continue;
        const cameBack = samples.slice(goneAt).findIndex((sample) => sample.includes(removed));
        expect(cameBack, `${removed} came back after being removed`).toBe(-1);
      }
      expect([...(samples.at(-1) ?? [])].sort()).toEqual([...newList].sort());
      return samples.length;
    }

    // A fixed shuffle so failures are reproducible: each round keeps some names, drops some
    // and adds some.
    const pick = (names: string[], round: number) =>
      names.filter((_, i) => (i * 7 + round * 3) % 5 < 3);

    it("reads during setUserRoles only ever see fewer roles (fail closed)", async () => {
      const roles = Array.from({ length: 24 }, (_, i) => `r${i}`);
      await db.createRoles(roles);
      let current = pick(roles, 0);
      await db.setUserRoles("sampled", current);
      for (let round = 1; round <= 8; round++) {
        const next = pick(roles, round);
        await sampleDuringSync(
          current,
          next,
          () => db.setUserRoles("sampled", next),
          async () => (await db.getUserAccess("sampled")).roles,
        );
        current = next;
      }
    });

    it("reads during setRolePermissions only ever see fewer permissions (fail closed)", async () => {
      const perms = Array.from({ length: 24 }, (_, i) => `p.n${i}`);
      await db.createPermissions(perms);
      await db.addUserRoles("sampled", ["editor"]);
      let current = pick(perms, 0);
      await db.setRolePermissions("editor", current);
      for (let round = 1; round <= 8; round++) {
        const next = pick(perms, round);
        await sampleDuringSync(
          current,
          next,
          () => db.setRolePermissions("editor", next),
          async () => (await db.getUserAccess("sampled")).rolePermissions,
        );
        current = next;
      }
    });

    it("treats user ids as opaque strings", async () => {
      const uuid = "3f2b8c1e-8a4d-4f1c-9e2a-7b6d5c4e3f21";
      await db.addUserRoles(uuid, ["admin"]);
      await db.addUserRoles("1", ["editor"]);
      expect((await db.getUserAccess(uuid)).roles).toEqual(["admin"]);
      expect((await db.getUserAccess("01")).roles).toEqual([]);
    });
  });
}
