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

    it("treats user ids as opaque strings", async () => {
      const uuid = "3f2b8c1e-8a4d-4f1c-9e2a-7b6d5c4e3f21";
      await db.addUserRoles(uuid, ["admin"]);
      await db.addUserRoles("1", ["editor"]);
      expect((await db.getUserAccess(uuid)).roles).toEqual(["admin"]);
      expect((await db.getUserAccess("01")).roles).toEqual([]);
    });
  });
}
