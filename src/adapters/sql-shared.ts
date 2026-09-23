// Helpers shared by the SQL adapters. Bundled into each adapter; nothing here is public.
import { createHash } from "node:crypto";
import { InvalidInputError } from "../core/errors";

export const DEFAULT_PREFIX = "perm_";
/** Keeps the longest table name plus MySQL's generated "_ibfk_N" constraint names within 64 chars. */
export const MAX_PREFIX_LENGTH = 32;
/** Max names per IN (...) list. Larger lists are split into several queries. */
export const CHUNK_SIZE = 500;

export interface TableNames {
  roles: string;
  permissions: string;
  rolePermissions: string;
  userRoles: string;
  userPermissions: string;
}

/**
 * Table names are the only part of any query that isn't a bound parameter, so the prefix is
 * restricted to letters, digits and "_" before it is ever put into SQL.
 */
export function validatePrefix(prefix: unknown): string {
  if (prefix === undefined) return DEFAULT_PREFIX;
  if (typeof prefix !== "string" || !/^[A-Za-z0-9_]*$/.test(prefix)) {
    throw new InvalidInputError(
      `Table prefix must contain only letters, numbers and "_", got ${JSON.stringify(prefix)}.`,
    );
  }
  if (prefix.length > MAX_PREFIX_LENGTH) {
    throw new InvalidInputError(
      `Table prefix must be at most ${MAX_PREFIX_LENGTH} characters, got ${prefix.length}.`,
    );
  }
  return prefix;
}

/** Quoted table names. `quote` wraps an already-validated identifier (backticks or double quotes). */
export function tableNames(prefix: string, quote: (name: string) => string): TableNames {
  return {
    roles: quote(`${prefix}roles`),
    permissions: quote(`${prefix}permissions`),
    rolePermissions: quote(`${prefix}role_permissions`),
    userRoles: quote(`${prefix}user_roles`),
    userPermissions: quote(`${prefix}user_permissions`),
  };
}

/**
 * Name of the per-user lock taken by syncRoles. MySQL caps lock names at 64 characters, so the
 * user id (up to 64 characters itself) is hashed: at most 7 + 32 + 1 + 16 = 56 characters.
 * A hash collision would only make two users' syncs wait for each other, never mix data.
 */
export function userLockName(prefix: string, userId: string): string {
  const hash = createHash("sha1").update(userId).digest("hex").slice(0, 16);
  return `permly:${prefix}:${hash}`;
}

export function chunk<T>(items: readonly T[], size = CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** "?, ?, ?" for MySQL-style placeholders. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** Runs `fn`, retrying once if it fails with an error `isRetryable` accepts (e.g. a deadlock). */
export async function retryOnce<T>(
  fn: () => Promise<T>,
  isRetryable: (err: unknown) => boolean,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isRetryable(err)) throw err;
    return fn();
  }
}
