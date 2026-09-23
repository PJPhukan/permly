import { describe, expect, it } from "vitest";
import { memoryAdapter } from "../../src/adapters/memory";
import { createPermissions } from "../../src/core/create-permissions";
import { InvalidInputError } from "../../src/core/errors";
import { setup } from "../helpers";

// Simulates plain-JS callers, where TypeScript can't stop bad input.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const create = createPermissions as (config: any) => unknown;

describe("config validation", () => {
  it.each([
    [undefined, "createPermissions() expects a config object, got undefined."],
    [[], "createPermissions() expects a config object, got an array."],
    [{}, 'config.adapter is required, e.g. memoryAdapter() from "permly/memory". Got undefined.'],
    [{ adapter: { listRoles() {} } }, "config.adapter is missing method(s): listPermissions,"],
    [
      { adapter: memoryAdapter(), permisions: [] },
      'Unknown config option "permisions". Did you mean "permissions"?',
    ],
    [
      { adapter: memoryAdapter(), cache: 60 },
      "config.cache must be an object like { ttl: 60 } or false.",
    ],
    [
      { adapter: memoryAdapter(), cache: { ttl: -1 } },
      "config.cache.ttl must be a number of seconds (0 or more), got number.",
    ],
    [
      { adapter: memoryAdapter(), strict: "yes" },
      'config.strict must be true or false, got "yes".',
    ],
    [
      { adapter: memoryAdapter(), roles: "admin" },
      'config.roles() expects an array of role names, got "admin".',
    ],
    [
      { adapter: memoryAdapter(), permissions: ["posts edit"] },
      'Permission name "posts edit" is invalid.',
    ],
    [
      { adapter: memoryAdapter(), permissions: ["posts.*"] },
      'Wildcard "posts.*" is not allowed here.',
    ],
  ])("rejects %j", (config, message) => {
    expect(() => create(config)).toThrow(InvalidInputError);
    expect(() => create(config)).toThrow(message);
  });

  it("accepts cache: false and ttl: 0", () => {
    expect(() => create({ adapter: memoryAdapter(), cache: false })).not.toThrow();
    expect(() => create({ adapter: memoryAdapter(), cache: { ttl: 0 } })).not.toThrow();
  });
});

describe("user ids", () => {
  const perms = createPermissions({ adapter: memoryAdapter() });
  const user = perms.user as (id: unknown) => unknown;

  it.each([
    [null, "User id must be a string, number or ObjectId, got null."],
    [undefined, "User id must be a string, number or ObjectId, got undefined."],
    [{}, "User id must be a string, number or ObjectId, got object."],
    [1.5, "User id must be an integer, got 1.5."],
    [NaN, "User id must be an integer, got NaN."],
    ["", "User id must be 1-64 characters long, got 0."],
    ["x".repeat(65), "User id must be 1-64 characters long, got 65."],
  ])("rejects %j", (id, message) => {
    expect(() => user(id)).toThrow(message);
  });

  it.each([1, 0, "abc", "3f2b8c1e-8a4d-4f1c-9e2a-7b6d5c4e3f21", "x".repeat(64)])(
    "accepts %j",
    (id) => {
      expect(() => user(id)).not.toThrow();
    },
  );
});

describe("names", () => {
  it.each([
    [123, "Permission name must be a string, got number."],
    ["", "Permission name must be 1-150 characters long, got 0."],
    ["posts..edit", 'Permission name "posts..edit" is invalid.'],
    [".posts", 'Permission name ".posts" is invalid.'],
    ["posts edit", 'Permission name "posts edit" is invalid.'],
    ["posts;drop", 'Permission name "posts;drop" is invalid.'],
  ])("rejects permission %j", async (name, message) => {
    const { perms } = await setup();
    const can = perms.user(1).can as (p: unknown) => Promise<boolean>;
    await expect(can(name)).rejects.toThrow(message);
  });

  it.each([
    ["*.posts", 'Wildcard "*.posts" is not allowed here.'],
    ["posts.*.edit", 'Wildcard "posts.*.edit" is not allowed here.'],
    [".*", 'Wildcard ".*" is invalid.'],
  ])("rejects grant %j", async (name, message) => {
    const { perms } = await setup();
    const give = perms.role("admin").givePermission as (p: unknown) => Promise<void>;
    await expect(give(name)).rejects.toThrow(message);
  });

  it("rejects bad role names synchronously", () => {
    const perms = createPermissions({ adapter: memoryAdapter() });
    expect(() => perms.role("super admin")).toThrow('Role name "super admin" is invalid.');
  });

  it("requires at least one name for rest-argument methods", async () => {
    const { perms } = await setup();
    await expect(perms.user(1).assignRole()).rejects.toThrow(
      "assignRole() needs at least one role name.",
    );
    await expect(perms.role("admin").givePermission()).rejects.toThrow(
      "givePermission() needs at least one permission name.",
    );
  });

  it("requires arrays for list methods", async () => {
    const { perms } = await setup();
    const syncRoles = perms.user(1).syncRoles as (r: unknown) => Promise<void>;
    await expect(syncRoles("admin")).rejects.toThrow(
      'syncRoles() expects an array of role names, got "admin".',
    );
  });

  it("validates getPermissions options", async () => {
    const { perms } = await setup();
    const get = perms.user(1).getPermissions as (o: unknown) => Promise<string[]>;
    await expect(get("expand")).rejects.toThrow("getPermissions() options must be an object");
    await expect(get({ expand: "yes" })).rejects.toThrow('option "expand" must be true or false');
  });

  it("does not call the adapter when input is invalid", async () => {
    const { perms, adapter } = await setup();
    const give = perms.user(1).givePermission as (p: unknown) => Promise<void>;
    await expect(give(42)).rejects.toThrow();
    expect(adapter.addUserPermissions).not.toHaveBeenCalled();
    expect(adapter.listPermissions).not.toHaveBeenCalled();
  });
});
