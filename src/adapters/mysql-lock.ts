import { createHash } from "node:crypto";

/**
 * Name of the per-user lock taken by syncRoles. MySQL caps lock names at 64 characters, so the
 * user id (up to 64 characters itself) is hashed: at most 7 + 32 + 1 + 16 = 56 characters.
 * A hash collision would only make two users' syncs wait for each other, never mix data.
 */
export function userLockName(prefix: string, userId: string): string {
  const hash = createHash("sha1").update(userId).digest("hex").slice(0, 16);
  return `permly:${prefix}:${hash}`;
}
