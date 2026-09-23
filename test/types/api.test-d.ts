import { describe, expectTypeOf, it } from "vitest";
import { memoryAdapter } from "../../src/adapters/memory";
import { createPermissions } from "../../src/core/create-permissions";
import type { Wildcard } from "../../src/core/types";

const perms = createPermissions({
  adapter: memoryAdapter(),
  permissions: ["posts.create", "posts.edit", "posts.edit.own", "users.ban"],
  roles: ["admin", "editor"],
});

describe("typed config (no `as const` needed)", () => {
  it("accepts known names", () => {
    perms.user(1).can("posts.edit");
    perms.user("a").canAll(["posts.create", "users.ban"]);
    perms.user(1).assignRole("admin", "editor");
    perms.role("editor").givePermission("posts.create", "posts.*", "posts.edit.*", "*");
    perms.user(1).canOwn("posts.edit", 5);
  });

  it("rejects typos", () => {
    // @ts-expect-error unknown permission
    perms.user(1).can("posts.edt");
    // @ts-expect-error unknown role
    perms.user(1).assignRole("admn");
    // @ts-expect-error unknown role
    perms.role("viewer");
    // @ts-expect-error wildcards can't be checked
    perms.user(1).can("posts.*");
    // @ts-expect-error wildcard that matches nothing
    perms.role("admin").givePermission("psts.*");
  });

  it("returns the right types", () => {
    expectTypeOf(perms.user(1).can("posts.edit")).toEqualTypeOf<Promise<boolean>>();
    expectTypeOf(perms.user(1).getPermissions()).toEqualTypeOf<Promise<string[]>>();
    expectTypeOf(perms.user(1).authorize("users.ban")).toEqualTypeOf<Promise<void>>();
  });
});

describe("untyped config", () => {
  it("accepts any string", () => {
    const loose = createPermissions({ adapter: memoryAdapter() });
    loose.user(1).can("anything.at.all");
    loose.role("whatever").givePermission("x.y", "*");
  });
});

describe("Wildcard", () => {
  it("derives every prefix wildcard", () => {
    expectTypeOf<Wildcard<"a.b.c">>().toEqualTypeOf<"*" | "a.*" | "a.b.*">();
    expectTypeOf<Wildcard<"flat">>().toEqualTypeOf<"*">();
    expectTypeOf<Wildcard<string>>().toEqualTypeOf<"*">();
  });

  it("stops at depth 5", () => {
    expectTypeOf<Wildcard<"a.b.c.d.e.f.g.h">>().toEqualTypeOf<
      "*" | "a.*" | "a.b.*" | "a.b.c.*" | "a.b.c.d.*" | "a.b.c.d.e.*"
    >();
  });
});
