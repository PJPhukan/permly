// Errors carry this brand so they can be recognised even when two copies of permly are loaded
// (e.g. one via require and one via import), where `instanceof` would fail.
const BRAND = Symbol.for("permly.error");

export type PermissionsErrorCode =
  "PERMISSION_DENIED" | "ROLE_NOT_FOUND" | "PERMISSION_NOT_FOUND" | "INVALID_INPUT";

export class PermissionsError extends Error {
  readonly code: PermissionsErrorCode;

  constructor(code: PermissionsErrorCode, message: string) {
    super(message);
    this.name = "PermissionsError";
    this.code = code;
    Object.defineProperty(this, BRAND, { value: code });
  }
}

export class PermissionDeniedError extends PermissionsError {
  readonly missing: string[];

  constructor(missing: string[]) {
    super("PERMISSION_DENIED", `Permission denied. Missing: ${missing.map(quote).join(", ")}.`);
    this.name = "PermissionDeniedError";
    this.missing = missing;
  }
}

export interface NotFoundDetails {
  /** Closest existing name, if one is similar enough. */
  suggestion?: string | undefined;
  /** The name is listed in config but not in the database, so sync() probably wasn't run. */
  inConfig?: boolean;
}

export class RoleNotFoundError extends PermissionsError {
  readonly role: string;
  readonly suggestion: string | undefined;

  constructor(role: string, details: NotFoundDetails = {}) {
    super("ROLE_NOT_FOUND", `Role ${quote(role)} does not exist.${hint(details)}`);
    this.name = "RoleNotFoundError";
    this.role = role;
    this.suggestion = details.suggestion;
  }
}

export class PermissionNotFoundError extends PermissionsError {
  readonly permission: string;
  readonly suggestion: string | undefined;

  constructor(permission: string, details: NotFoundDetails = {}) {
    const problem = permission.endsWith("*")
      ? `Wildcard ${quote(permission)} does not match any existing permission.`
      : `Permission ${quote(permission)} does not exist.`;
    super("PERMISSION_NOT_FOUND", problem + hint(details));
    this.name = "PermissionNotFoundError";
    this.permission = permission;
    this.suggestion = details.suggestion;
  }
}

export class InvalidInputError extends PermissionsError {
  constructor(message: string) {
    super("INVALID_INPUT", message);
    this.name = "InvalidInputError";
  }
}

function brandOf(err: unknown): unknown {
  return typeof err === "object" && err !== null
    ? (err as Record<symbol, unknown>)[BRAND]
    : undefined;
}

/** True for any error thrown by permly, from any copy of the package. */
export function isPermissionsError(err: unknown): err is PermissionsError {
  return typeof brandOf(err) === "string";
}

/** True for PermissionDeniedError from any copy of the package. Use instead of `instanceof`. */
export function isPermissionDeniedError(err: unknown): err is PermissionDeniedError {
  return brandOf(err) === "PERMISSION_DENIED";
}

function quote(name: string): string {
  return `"${name}"`;
}

function hint({ suggestion, inConfig }: NotFoundDetails): string {
  if (inConfig)
    return " It is listed in your config but not in the database. Did you run perms.sync()?";
  if (suggestion !== undefined) return ` Did you mean ${quote(suggestion)}?`;
  return "";
}
