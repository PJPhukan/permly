import { describe, expect, it } from "vitest";
import { memoryAdapter } from "../../src/adapters/memory";
import { createPermissions } from "../../src/core/create-permissions";
import {
  InvalidInputError,
  PermissionDeniedError,
  PermissionNotFoundError,
  RoleNotFoundError,
} from "../../src/core/errors";
import { setup } from "../helpers";

describe("sync", () => {
  it("creates configured roles and permissions, then does nothing", async () => {
    const perms = createPermissions({
      adapter: memoryAdapter(),
      permissions: ["posts.edit", "posts.create"],
      roles: ["admin"],
    });
    expect(await perms.sync()).toEqual({
      createdRoles: ["admin"],
      createdPermissions: ["posts.edit", "posts.create"],
    });
    expect(await perms.sync()).toEqual({ createdRoles: [], createdPermissions: [] });
    expect(await perms.getAllPermissions()).toEqual(["posts.create", "posts.edit"]);
  });

  it("never deletes existing rows", async () => {
    const adapter = memoryAdapter();
    await createPermissions({ adapter, roles: ["old"] }).sync();
    await createPermissions({ adapter, roles: ["new"] }).sync();
    expect(await adapter.listRoles()).toEqual(["old", "new"]);
  });

  it("works without config lists (plain JS style)", async () => {
    const perms = createPermissions({ adapter: memoryAdapter() });
    expect(await perms.sync()).toEqual({ createdRoles: [], createdPermissions: [] });
    await perms.createRole("admin");
    await perms.createPermission("posts.edit");
    await perms.role("admin").givePermission("posts.edit");
    await perms.user(1).assignRole("admin");
    expect(await perms.user(1).can("posts.edit")).toBe(true);
  });
});

describe("roles", () => {
  it("gives, revokes and syncs permissions", async () => {
    const { perms } = await setup();
    const editor = perms.role("editor");
    await editor.givePermission("posts.create", "posts.edit");
    expect(await editor.getPermissions()).toEqual(["posts.create", "posts.edit"]);

    await editor.revokePermission("posts.edit");
    expect(await editor.getPermissions()).toEqual(["posts.create"]);

    await editor.syncPermissions(["posts.delete", "users.ban"]);
    expect(await editor.getPermissions()).toEqual(["posts.delete", "users.ban"]);

    await editor.syncPermissions([]);
    expect(await editor.getPermissions()).toEqual([]);
  });

  it("accepts an array instead of rest arguments", async () => {
    const { perms } = await setup();
    await perms.role("editor").givePermission(...(["posts.create"] as const));
    await (perms.role("editor").givePermission as (...a: unknown[]) => Promise<void>)([
      "posts.edit",
    ]);
    expect(await perms.role("editor").getPermissions()).toEqual(["posts.create", "posts.edit"]);
  });

  it("changes apply to users who already have the role", async () => {
    const { perms } = await setup();
    await perms.user(1).assignRole("editor");
    expect(await perms.user(1).can("posts.edit")).toBe(false);
    await perms.role("editor").givePermission("posts.edit");
    expect(await perms.user(1).can("posts.edit")).toBe(true);
    await perms.role("editor").revokePermission("posts.edit");
    expect(await perms.user(1).can("posts.edit")).toBe(false);
  });

  it("throws for unknown roles and permissions with suggestions", async () => {
    const { perms } = await setup();
    await expect(perms.role("editr" as "editor").givePermission("posts.edit")).rejects.toThrow(
      'Role "editr" does not exist. Did you mean "editor"?',
    );
    await expect(perms.role("editor").givePermission("posts.edt" as "posts.edit")).rejects.toThrow(
      'Permission "posts.edt" does not exist. Did you mean "posts.edit"?',
    );
  });

  it("deleting a role removes it from users", async () => {
    const { perms } = await setup();
    await perms.role("admin").givePermission("users.ban");
    await perms.user(1).assignRole("admin", "editor");
    await perms.deleteRole("admin");
    expect(await perms.user(1).getRoles()).toEqual(["editor"]);
    expect(await perms.user(1).can("users.ban")).toBe(false);
    await expect(perms.deleteRole("admin")).rejects.toBeInstanceOf(RoleNotFoundError);
  });

  it("deleting a permission removes it everywhere", async () => {
    const { perms } = await setup();
    await perms.role("editor").givePermission("posts.edit");
    await perms.user(1).givePermission("posts.edit");
    await perms.deletePermission("posts.edit");
    expect(await perms.role("editor").getPermissions()).toEqual([]);
    expect(await perms.user(1).getPermissions()).toEqual([]);
    await expect(perms.user(1).can("posts.edit")).rejects.toBeInstanceOf(PermissionNotFoundError);
  });
});

describe("users", () => {
  it("assigns, removes and syncs roles", async () => {
    const { perms } = await setup();
    const user = perms.user(1);
    await user.assignRole("editor", "viewer");
    expect(await user.getRoles()).toEqual(["editor", "viewer"]);
    await user.removeRole("viewer");
    expect(await user.getRoles()).toEqual(["editor"]);
    await user.syncRoles(["admin", "viewer"]);
    expect(await user.getRoles()).toEqual(["admin", "viewer"]);
    await user.syncRoles([]);
    expect(await user.getRoles()).toEqual([]);
  });

  it("gives and revokes direct permissions", async () => {
    const { perms } = await setup();
    await perms.user(1).givePermission("posts.delete");
    expect(await perms.user(1).can("posts.delete")).toBe(true);
    await perms.user(1).revokePermission("posts.delete");
    expect(await perms.user(1).can("posts.delete")).toBe(false);
  });

  it("merges role and direct permissions", async () => {
    const { perms } = await setup();
    await perms.role("editor").givePermission("posts.create", "posts.edit");
    await perms.role("viewer").givePermission("posts.edit");
    await perms.user(1).assignRole("editor", "viewer");
    await perms.user(1).givePermission("posts.delete");
    expect(await perms.user(1).getPermissions()).toEqual([
      "posts.create",
      "posts.delete",
      "posts.edit",
    ]);
  });

  it("treats number and string ids as the same user", async () => {
    const { perms } = await setup();
    await perms.user(42).assignRole("admin");
    expect(await perms.user("42").hasRole("admin")).toBe(true);
  });

  it("accepts ObjectId-like ids", async () => {
    const { perms } = await setup();
    const objectId = { toHexString: () => "507f1f77bcf86cd799439011" };
    await perms.user(objectId).assignRole("admin");
    expect(await perms.user("507f1f77bcf86cd799439011").hasRole("admin")).toBe(true);
  });

  it("keeps users separate", async () => {
    const { perms } = await setup();
    await perms.user(1).assignRole("admin");
    expect(await perms.user(2).hasRole("admin")).toBe(false);
  });
});

describe("checks", () => {
  async function editor() {
    const { perms, adapter } = await setup();
    await perms.role("editor").givePermission("posts.create", "posts.edit");
    await perms.user(1).assignRole("editor");
    return { perms, adapter, user: perms.user(1) };
  }

  it("can / canAny / canAll", async () => {
    const { user } = await editor();
    expect(await user.can("posts.edit")).toBe(true);
    expect(await user.can("posts.delete")).toBe(false);
    expect(await user.canAny(["posts.delete", "posts.edit"])).toBe(true);
    expect(await user.canAny(["posts.delete", "users.ban"])).toBe(false);
    expect(await user.canAll(["posts.create", "posts.edit"])).toBe(true);
    expect(await user.canAll(["posts.create", "posts.delete"])).toBe(false);
  });

  it("hasRole / hasAnyRole / hasAllRoles", async () => {
    const { user } = await editor();
    expect(await user.hasRole("editor")).toBe(true);
    expect(await user.hasRole("admin")).toBe(false);
    expect(await user.hasAnyRole(["admin", "editor"])).toBe(true);
    expect(await user.hasAnyRole(["admin", "viewer"])).toBe(false);
    expect(await user.hasAllRoles(["editor"])).toBe(true);
    expect(await user.hasAllRoles(["admin", "editor"])).toBe(false);
  });

  it("rejects empty lists instead of guessing", async () => {
    const { user } = await editor();
    await expect(user.canAll([])).rejects.toThrow("canAll() needs at least one permission name.");
    await expect(user.canAny([])).rejects.toBeInstanceOf(InvalidInputError);
    await expect(user.hasAnyRole([])).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("authorize throws PermissionDeniedError listing what is missing", async () => {
    const { user } = await editor();
    await expect(user.authorize("posts.edit")).resolves.toBeUndefined();
    await expect(user.authorize(["posts.edit", "posts.create"])).resolves.toBeUndefined();

    const error = await user.authorize(["posts.edit", "posts.delete", "users.ban"]).catch((e) => e);
    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect(error.missing).toEqual(["posts.delete", "users.ban"]);
    expect(error.message).toBe('Permission denied. Missing: "posts.delete", "users.ban".');
  });

  it("a user with no roles can do nothing", async () => {
    const { perms } = await setup();
    expect(await perms.user(99).can("posts.edit")).toBe(false);
    expect(await perms.user(99).getRoles()).toEqual([]);
    expect(await perms.user(99).getPermissions()).toEqual([]);
  });
});

describe("canOwn", () => {
  it("allows the full permission regardless of owner", async () => {
    const { perms } = await setup();
    await perms.user(1).givePermission("posts.edit");
    expect(await perms.user(1).canOwn("posts.edit", 2)).toBe(true);
    expect(await perms.user(1).canOwn("posts.edit", null)).toBe(true);
  });

  it("allows the .own permission only for the owner", async () => {
    const { perms } = await setup();
    await perms.user(1).givePermission("posts.edit.own");
    expect(await perms.user(1).canOwn("posts.edit", 1)).toBe(true);
    expect(await perms.user(1).canOwn("posts.edit", "1")).toBe(true);
    expect(await perms.user(1).canOwn("posts.edit", 2)).toBe(false);
    expect(await perms.user(1).canOwn("posts.edit", null)).toBe(false);
    expect(await perms.user(1).canOwn("posts.edit", undefined)).toBe(false);
  });

  it("is false without either permission", async () => {
    const { perms } = await setup();
    expect(await perms.user(1).canOwn("posts.edit", 1)).toBe(false);
  });

  it("works when no .own permission exists", async () => {
    const { perms } = await setup();
    await perms.user(1).givePermission("posts.delete");
    expect(await perms.user(1).canOwn("posts.delete", 1)).toBe(true);
    expect(await perms.user(2).canOwn("posts.delete", 2)).toBe(false);
  });

  it("validates the owner id", async () => {
    const { perms } = await setup();
    await expect(perms.user(1).canOwn("posts.edit", 1.5)).rejects.toThrow(
      "Owner id must be an integer, got 1.5.",
    );
  });
});

describe("wildcards", () => {
  it("prefix wildcard grants every permission under it", async () => {
    const { perms } = await setup();
    await perms.role("editor").givePermission("posts.*");
    await perms.user(1).assignRole("editor");
    const user = perms.user(1);
    expect(await user.can("posts.edit")).toBe(true);
    expect(await user.can("posts.edit.own")).toBe(true);
    expect(await user.can("users.ban")).toBe(false);
  });

  it("nested wildcard", async () => {
    const { perms } = await setup();
    await perms.user(1).givePermission("posts.edit.*");
    expect(await perms.user(1).can("posts.edit.own")).toBe(true);
    expect(await perms.user(1).can("posts.edit")).toBe(false);
  });

  it('"*" grants everything', async () => {
    const { perms } = await setup();
    await perms.role("admin").givePermission("*");
    await perms.user(1).assignRole("admin");
    expect(await perms.user(1).canAll(["posts.delete", "users.ban"])).toBe(true);
  });

  it("creates the wildcard row on first grant", async () => {
    const { perms } = await setup();
    await perms.role("admin").givePermission("posts.*");
    expect(await perms.getAllPermissions()).toContain("posts.*");
  });

  it("rejects wildcards that match nothing", async () => {
    const { perms } = await setup();
    await expect(perms.role("admin").givePermission("psts.*" as "posts.*")).rejects.toThrow(
      'Wildcard "psts.*" does not match any existing permission. Did you mean "posts.*"?',
    );
    await expect(perms.role("admin").givePermission("posts.delete.*" as "posts.*")).rejects.toThrow(
      PermissionNotFoundError,
    );
  });

  it("revokes a wildcard", async () => {
    const { perms } = await setup();
    await perms.user(1).givePermission("posts.*");
    await perms.user(1).revokePermission("posts.*");
    expect(await perms.user(1).can("posts.edit")).toBe(false);
  });

  it("wildcards cannot be checked or created directly", async () => {
    const { perms } = await setup();
    await expect(perms.user(1).can("posts.*" as "posts.edit")).rejects.toThrow(
      'Wildcard "posts.*" is not allowed here.',
    );
    await expect(perms.createPermission("posts.*")).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("getPermissions returns wildcards as stored, or expanded", async () => {
    const { perms } = await setup();
    await perms.role("editor").givePermission("posts.edit.*");
    await perms.user(1).assignRole("editor");
    await perms.user(1).givePermission("users.ban");

    expect(await perms.user(1).getPermissions()).toEqual(["posts.edit.*", "users.ban"]);
    expect(await perms.user(1).getPermissions({ expand: true })).toEqual([
      "posts.edit.own",
      "users.ban",
    ]);
    expect(await perms.role("editor").getPermissions({ expand: true })).toEqual(["posts.edit.own"]);
  });

  it("deleting a wildcard permission removes the grant", async () => {
    const { perms } = await setup();
    await perms.user(1).givePermission("*");
    await perms.deletePermission("*");
    expect(await perms.user(1).can("posts.edit")).toBe(false);
  });
});

describe("strict mode", () => {
  it("throws for unknown names in checks by default", async () => {
    const { perms } = await setup();
    await expect(perms.user(1).can("posts.edt" as "posts.edit")).rejects.toThrow(
      'Permission "posts.edt" does not exist. Did you mean "posts.edit"?',
    );
    await expect(perms.user(1).hasRole("admn" as "admin")).rejects.toThrow(
      'Role "admn" does not exist. Did you mean "admin"?',
    );
  });

  it("strict: false returns false for unknown names", async () => {
    const { perms } = await setup({ strict: false });
    await perms.user(1).givePermission("*");
    await perms.user(1).assignRole("admin");
    const user = perms.user(1) as ReturnType<typeof perms.user> & {
      can(p: string): Promise<boolean>;
      hasRole(r: string): Promise<boolean>;
      canAny(p: string[]): Promise<boolean>;
      authorize(p: string[]): Promise<void>;
    };
    expect(await user.can("nope.nope")).toBe(false);
    expect(await user.hasRole("ghost")).toBe(false);
    expect(await user.canAny(["nope.nope", "posts.edit"])).toBe(true);
    await expect(user.authorize(["nope.nope", "posts.edit"])).rejects.toMatchObject({
      missing: ["nope.nope"],
    });
  });

  it("strict: false still validates changes", async () => {
    const { perms } = await setup({ strict: false });
    await expect(perms.user(1).assignRole("ghost" as "admin")).rejects.toBeInstanceOf(
      RoleNotFoundError,
    );
  });

  it("hints at sync() when a configured name is missing from the database", async () => {
    const perms = createPermissions({
      adapter: memoryAdapter(),
      permissions: ["posts.edit"],
      roles: ["admin"],
    });
    await expect(perms.user(1).can("posts.edit")).rejects.toThrow(
      'Permission "posts.edit" does not exist. It is listed in your config but not in the database. Did you run perms.sync()?',
    );
    await expect(perms.user(1).assignRole("admin")).rejects.toThrow("Did you run perms.sync()?");
  });
});

describe("type guards", () => {
  it("isPermission returns true for configured permissions", async () => {
    const perms = createPermissions({
      adapter: memoryAdapter(),
      permissions: ["posts.edit", "posts.create"],
      roles: ["admin"],
    });
    await perms.sync();
    expect(perms.isPermission("posts.edit")).toBe(true);
    expect(perms.isPermission("posts.create")).toBe(true);
    expect(perms.isPermission("posts.delete")).toBe(false);
    expect(perms.isPermission("unknown")).toBe(false);
  });

  it("isRole returns true for configured roles", async () => {
    const perms = createPermissions({
      adapter: memoryAdapter(),
      permissions: ["posts.edit"],
      roles: ["admin", "editor"],
    });
    await perms.sync();
    expect(perms.isRole("admin")).toBe(true);
    expect(perms.isRole("editor")).toBe(true);
    expect(perms.isRole("viewer")).toBe(false);
    expect(perms.isRole("unknown")).toBe(false);
  });

  it("isPermission returns false for non-strings", async () => {
    const perms = createPermissions({
      adapter: memoryAdapter(),
      permissions: ["posts.edit"],
      roles: ["admin"],
    });
    await perms.sync();
    expect(perms.isPermission(123)).toBe(false);
    expect(perms.isPermission(null)).toBe(false);
    expect(perms.isPermission(undefined)).toBe(false);
    expect(perms.isPermission(true)).toBe(false);
    expect(perms.isPermission({})).toBe(false);
    expect(perms.isPermission([])).toBe(false);
  });

  it("isRole returns false for non-strings", async () => {
    const perms = createPermissions({
      adapter: memoryAdapter(),
      permissions: ["posts.edit"],
      roles: ["admin"],
    });
    await perms.sync();
    expect(perms.isRole(123)).toBe(false);
    expect(perms.isRole(null)).toBe(false);
    expect(perms.isRole(undefined)).toBe(false);
    expect(perms.isRole(true)).toBe(false);
    expect(perms.isRole({})).toBe(false);
    expect(perms.isRole([])).toBe(false);
  });

  it("isPermission never throws, even in strict mode", async () => {
    const perms = createPermissions({
      adapter: memoryAdapter(),
      permissions: ["posts.edit"],
      roles: ["admin"],
      strict: true,
    });
    await perms.sync();
    expect(() => perms.isPermission("unknown")).not.toThrow();
    expect(() => perms.isPermission(null)).not.toThrow();
  });

  it("isRole never throws, even in strict mode", async () => {
    const perms = createPermissions({
      adapter: memoryAdapter(),
      permissions: ["posts.edit"],
      roles: ["admin"],
      strict: true,
    });
    await perms.sync();
    expect(() => perms.isRole("unknown")).not.toThrow();
    expect(() => perms.isRole(null)).not.toThrow();
  });

  it("isPermission rejects wildcards", async () => {
    const perms = createPermissions({
      adapter: memoryAdapter(),
      permissions: ["posts.edit"],
      roles: ["admin"],
    });
    await perms.sync();
    expect(perms.isPermission("posts.*")).toBe(false);
    expect(perms.isPermission("*")).toBe(false);
  });

  it("works without config lists (plain JS style)", async () => {
    const perms = createPermissions({ adapter: memoryAdapter() });
    await perms.createPermission("posts.edit");
    await perms.createRole("admin");
    await perms.sync();

    // Load the catalog into cache so isPermission/isRole can check it
    await perms.getAllPermissions();
    await perms.getAllRoles();

    expect(perms.isPermission("posts.edit")).toBe(true);
    expect(perms.isPermission("posts.delete")).toBe(false);
    expect(perms.isRole("admin")).toBe(true);
    expect(perms.isRole("editor")).toBe(false);
  });
});
