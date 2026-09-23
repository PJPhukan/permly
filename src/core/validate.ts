import { InvalidInputError } from "./errors";
import { suggest } from "./similarity";
import type { PermissionAdapter } from "./types";

export const MAX_NAME_LENGTH = 150;
export const MAX_USER_ID_LENGTH = 64;
const DEFAULT_TTL_SECONDS = 60;

const NAME_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

type Kind = "Role" | "Permission";

const ADAPTER_METHODS: readonly (keyof PermissionAdapter)[] = [
  "listRoles",
  "listPermissions",
  "createRoles",
  "createPermissions",
  "deleteRole",
  "deletePermission",
  "getRolePermissions",
  "addRolePermissions",
  "removeRolePermissions",
  "setRolePermissions",
  "getUserAccess",
  "addUserRoles",
  "removeUserRoles",
  "setUserRoles",
  "addUserPermissions",
  "removeUserPermissions",
];

const CONFIG_KEYS = ["adapter", "cache", "permissions", "roles", "strict"];

export function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return `"${value}"`;
  return typeof value;
}

export function isWildcard(name: string): boolean {
  return name === "*" || name.endsWith(".*");
}

/** A concrete role or permission name. Wildcards are rejected. */
export function assertName(kind: Kind, value: unknown): string {
  if (typeof value !== "string") {
    throw new InvalidInputError(`${kind} name must be a string, got ${describe(value)}.`);
  }
  if (value.length === 0 || value.length > MAX_NAME_LENGTH) {
    throw new InvalidInputError(
      `${kind} name must be 1-${MAX_NAME_LENGTH} characters long, got ${value.length}.`,
    );
  }
  if (kind === "Permission" && value.includes("*")) {
    throw new InvalidInputError(
      `Wildcard "${value}" is not allowed here. Wildcards can be granted and revoked, but not checked or created directly.`,
    );
  }
  if (!NAME_PATTERN.test(value)) {
    throw new InvalidInputError(
      `${kind} name "${value}" is invalid. Use letters, numbers, "_" and "-", separated by dots (e.g. "posts.edit").`,
    );
  }
  return value;
}

/** A concrete permission name, "*", or "prefix.*". */
export function assertPermissionPattern(value: unknown): string {
  if (value === "*") return value;
  if (typeof value === "string" && value.endsWith(".*")) {
    const prefix = value.slice(0, -2);
    if (prefix.length > 0 && prefix.length <= MAX_NAME_LENGTH - 2 && NAME_PATTERN.test(prefix)) {
      return value;
    }
    throw new InvalidInputError(
      `Wildcard "${value}" is invalid. Use "*" or a permission prefix followed by ".*" (e.g. "posts.*").`,
    );
  }
  return assertName("Permission", value);
}

interface ListOptions {
  allowWildcard?: boolean;
  allowEmpty?: boolean;
}

/** Names passed as rest arguments. A single array argument is accepted too. */
export function nameArgs(kind: Kind, method: string, args: unknown[], options: ListOptions = {}) {
  const values = args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  return names(kind, method, values, options);
}

/** Names passed as a single array argument. */
export function nameList(kind: Kind, method: string, value: unknown, options: ListOptions = {}) {
  if (!Array.isArray(value)) {
    throw new InvalidInputError(
      `${method}() expects an array of ${kind.toLowerCase()} names, got ${describe(value)}.`,
    );
  }
  return names(kind, method, value, options);
}

function names(kind: Kind, method: string, values: unknown[], options: ListOptions): string[] {
  if (values.length === 0 && !options.allowEmpty) {
    throw new InvalidInputError(`${method}() needs at least one ${kind.toLowerCase()} name.`);
  }
  const check = options.allowWildcard
    ? assertPermissionPattern
    : (v: unknown) => assertName(kind, v);
  return [...new Set(values.map(check))];
}

export function normalizeUserId(value: unknown, label = "User id"): string {
  let id: unknown = value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new InvalidInputError(`${label} must be an integer, got ${value}.`);
    }
    id = String(value);
  } else if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toHexString?: unknown }).toHexString === "function"
  ) {
    id = (value as { toHexString(): unknown }).toHexString();
  }
  if (typeof id !== "string") {
    throw new InvalidInputError(
      `${label} must be a string, number or ObjectId, got ${describe(value)}.`,
    );
  }
  if (id.length === 0 || id.length > MAX_USER_ID_LENGTH) {
    throw new InvalidInputError(
      `${label} must be 1-${MAX_USER_ID_LENGTH} characters long, got ${id.length}.`,
    );
  }
  return id;
}

export interface ResolvedConfig {
  adapter: PermissionAdapter;
  ttlMs: number;
  strict: boolean;
  roles: string[];
  permissions: string[];
}

export function validateConfig(config: unknown): ResolvedConfig {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new InvalidInputError(
      `createPermissions() expects a config object, got ${describe(config)}.`,
    );
  }
  const input = config as Record<string, unknown>;

  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.includes(key)) {
      const guess = suggest(key, CONFIG_KEYS);
      throw new InvalidInputError(
        `Unknown config option "${key}".${guess ? ` Did you mean "${guess}"?` : ""}`,
      );
    }
  }

  return {
    adapter: validateAdapter(input.adapter),
    ttlMs: validateCache(input.cache),
    strict: validateStrict(input.strict),
    roles:
      input.roles === undefined
        ? []
        : nameList("Role", "config.roles", input.roles, { allowEmpty: true }),
    permissions:
      input.permissions === undefined
        ? []
        : nameList("Permission", "config.permissions", input.permissions, { allowEmpty: true }),
  };
}

function validateAdapter(adapter: unknown): PermissionAdapter {
  if (typeof adapter !== "object" || adapter === null) {
    throw new InvalidInputError(
      `config.adapter is required, e.g. memoryAdapter() from "permly/memory". Got ${describe(adapter)}.`,
    );
  }
  const missing = ADAPTER_METHODS.filter(
    (method) => typeof (adapter as Record<string, unknown>)[method] !== "function",
  );
  if (missing.length > 0) {
    throw new InvalidInputError(`config.adapter is missing method(s): ${missing.join(", ")}.`);
  }
  return adapter as PermissionAdapter;
}

function validateCache(cache: unknown): number {
  if (cache === undefined) return DEFAULT_TTL_SECONDS * 1000;
  if (cache === false) return 0;
  if (typeof cache !== "object" || cache === null || Array.isArray(cache)) {
    throw new InvalidInputError(`config.cache must be an object like { ttl: 60 } or false.`);
  }
  const { ttl } = cache as { ttl?: unknown };
  if (ttl === undefined) return DEFAULT_TTL_SECONDS * 1000;
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl < 0) {
    throw new InvalidInputError(
      `config.cache.ttl must be a number of seconds (0 or more), got ${describe(ttl)}.`,
    );
  }
  return ttl * 1000;
}

function validateStrict(strict: unknown): boolean {
  if (strict === undefined) return true;
  if (typeof strict !== "boolean") {
    throw new InvalidInputError(`config.strict must be true or false, got ${describe(strict)}.`);
  }
  return strict;
}
