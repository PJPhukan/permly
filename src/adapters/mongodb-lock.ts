import { createHash } from "node:crypto";

/** _id of the lease-lock document for one user's syncRoles or one role's syncPermissions. */
export function leaseKey(kind: "user" | "role", value: string): string {
  return `${kind}:${createHash("sha1").update(value).digest("hex").slice(0, 32)}`;
}
