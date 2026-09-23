import { afterEach, describe, expect, it, vi } from "vitest";
import { TtlCache } from "../../src/core/cache";
import { setup } from "../helpers";

afterEach(() => {
  vi.useRealTimers();
});

describe("permission cache", () => {
  it("serves repeated checks without hitting the adapter", async () => {
    const { perms, adapter } = await setup();
    await perms.user(1).assignRole("editor");
    vi.clearAllMocks();

    for (let i = 0; i < 5; i++) await perms.user(1).can("posts.edit");
    expect(adapter.getUserAccess).toHaveBeenCalledTimes(1);
    // The role/permission name list was already cached by assignRole().
    expect(adapter.listPermissions).not.toHaveBeenCalled();
  });

  it("is cleared for the user when their roles change", async () => {
    const { perms, adapter } = await setup();
    await perms.role("editor").givePermission("posts.edit");
    expect(await perms.user(1).can("posts.edit")).toBe(false);
    await perms.user(1).assignRole("editor");
    expect(await perms.user(1).can("posts.edit")).toBe(true);
    await perms.user(1).removeRole("editor");
    expect(await perms.user(1).can("posts.edit")).toBe(false);
    expect(adapter.getUserAccess).toHaveBeenCalledTimes(3);
  });

  it("only clears the changed user", async () => {
    const { perms, adapter } = await setup();
    await perms.user(1).getRoles();
    await perms.user(2).getRoles();
    await perms.user(1).assignRole("admin");
    vi.clearAllMocks();
    await perms.user(2).getRoles();
    expect(adapter.getUserAccess).not.toHaveBeenCalled();
  });

  it("is fully cleared when a role changes", async () => {
    const { perms } = await setup();
    await perms.user(1).assignRole("editor");
    await perms.user(2).assignRole("editor");
    expect(await perms.user(2).can("posts.edit")).toBe(false);
    await perms.role("editor").givePermission("posts.edit");
    expect(await perms.user(2).can("posts.edit")).toBe(true);
  });

  it("expires after the ttl", async () => {
    vi.useFakeTimers();
    const { perms, adapter } = await setup({ cache: { ttl: 10 } });
    await perms.user(1).getRoles();
    await perms.user(1).getRoles();
    expect(adapter.getUserAccess).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_001);
    await perms.user(1).getRoles();
    expect(adapter.getUserAccess).toHaveBeenCalledTimes(2);
  });

  it("can be disabled", async () => {
    const { perms, adapter } = await setup({ cache: false });
    await perms.user(1).getRoles();
    await perms.user(1).getRoles();
    expect(adapter.getUserAccess).toHaveBeenCalledTimes(2);
  });

  it("clearCache() picks up changes made outside this instance", async () => {
    const { perms, adapter } = await setup();
    expect(await perms.user(1).hasRole("admin")).toBe(false);
    await adapter.addUserRoles("1", ["admin"]); // e.g. another server
    expect(await perms.user(1).hasRole("admin")).toBe(false);
    perms.clearCache();
    expect(await perms.user(1).hasRole("admin")).toBe(true);
  });
});

describe("TtlCache", () => {
  it("drops a load that raced with an invalidation", async () => {
    const cache = new TtlCache<string>(60_000);
    let finish!: (value: string) => void;
    const slow = cache.getOrLoad("k", () => new Promise((resolve) => (finish = resolve)));
    cache.delete("k"); // a write happens while the read is in flight
    finish("stale");
    expect(await slow).toBe("stale");
    expect(await cache.getOrLoad("k", async () => "fresh")).toBe("fresh");
  });

  it("stays bounded", async () => {
    const cache = new TtlCache<number>(60_000);
    for (let i = 0; i < 10_050; i++) await cache.getOrLoad(`k${i}`, async () => i);
    const load = vi.fn(async () => -1);
    expect(await cache.getOrLoad("k0", load)).toBe(-1); // evicted, reloaded
    expect(await cache.getOrLoad("k10049", load)).toBe(10_049); // still cached
  });
});
