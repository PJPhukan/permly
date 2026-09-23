import { vi } from "vitest";
import { memoryAdapter } from "../src/adapters/memory";
import { createPermissions } from "../src/core/create-permissions";
import type { PermissionAdapter, PermissionsConfig } from "../src/core/types";

export const PERMISSIONS = [
  "posts.create",
  "posts.edit",
  "posts.edit.own",
  "posts.delete",
  "users.ban",
] as const;
export const ROLES = ["admin", "editor", "viewer"] as const;

type P = (typeof PERMISSIONS)[number];
type R = (typeof ROLES)[number];

/** A memory adapter whose methods are vitest spies, so tests can count database calls. */
export function spyAdapter(): PermissionAdapter {
  const adapter = memoryAdapter();
  for (const key of Object.keys(adapter) as (keyof PermissionAdapter)[]) {
    vi.spyOn(adapter, key);
  }
  return adapter;
}

/** A synced instance with the standard test roles and permissions. */
export async function setup(options: Partial<PermissionsConfig<P, R>> = {}) {
  const adapter = options.adapter ?? spyAdapter();
  const perms = createPermissions({
    permissions: PERMISSIONS,
    roles: ROLES,
    ...options,
    adapter,
  });
  await perms.sync();
  vi.clearAllMocks();
  return { perms, adapter };
}
