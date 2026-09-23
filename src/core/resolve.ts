import { isWildcard } from "./validate";
import type { UserAccess } from "./types";

/** A user's merged roles and permissions, shaped for fast checks. */
export interface Grants {
  roles: ReadonlySet<string>;
  /** Role + direct permissions as stored, deduplicated and sorted. */
  permissions: readonly string[];
  exact: ReadonlySet<string>;
  /** Prefixes of granted wildcards, e.g. "posts." for "posts.*". */
  prefixes: readonly string[];
  all: boolean;
}

export function buildGrants(access: UserAccess): Grants {
  const permissions = [...new Set([...access.rolePermissions, ...access.directPermissions])].sort();
  const exact = new Set<string>();
  const prefixes: string[] = [];
  let all = false;
  for (const name of permissions) {
    if (name === "*") all = true;
    else if (isWildcard(name)) prefixes.push(name.slice(0, -1));
    else exact.add(name);
  }
  return { roles: new Set(access.roles), permissions, exact, prefixes, all };
}

export function isGranted(grants: Grants, permission: string): boolean {
  return (
    grants.all ||
    grants.exact.has(permission) ||
    grants.prefixes.some((prefix) => permission.startsWith(prefix))
  );
}

/** Does `pattern` (a concrete name, "*" or "prefix.*") cover `name`? */
export function matchesPattern(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

/** Concrete permissions from `catalog` covered by any of `granted`, sorted. */
export function expandPermissions(granted: readonly string[], catalog: Iterable<string>): string[] {
  const result: string[] = [];
  for (const name of catalog) {
    if (!isWildcard(name) && granted.some((pattern) => matchesPattern(pattern, name))) {
      result.push(name);
    }
  }
  return result.sort();
}

/** Every wildcard that would match at least one of `names`: "*", "posts.*", "posts.edit.*", ... */
export function wildcardsFor(names: Iterable<string>): Set<string> {
  const result = new Set<string>(["*"]);
  for (const name of names) {
    if (isWildcard(name)) continue;
    const parts = name.split(".");
    for (let i = 1; i < parts.length; i++) result.add(`${parts.slice(0, i).join(".")}.*`);
  }
  return result;
}
