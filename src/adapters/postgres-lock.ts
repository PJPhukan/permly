import { createHash } from "node:crypto";

/**
 * The 64-bit advisory lock key for one user's syncRoles, from a hash of schema, prefix and
 * user id. A collision would only make two users' syncs wait for each other.
 */
export function userLockKey(schema: string, prefix: string, userId: string): string {
  const digest = createHash("sha1").update(`permly:${schema}.${prefix}:${userId}`).digest();
  return digest.readBigInt64BE(0).toString();
}
