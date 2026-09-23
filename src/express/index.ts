import { InvalidInputError, isPermissionDeniedError } from "../core/errors";
import type { Permissions, UserId, UserScope } from "../core/types";

// Structural types only: permly never imports express, and works with Express 4 and 5.

/**
 * The request type used when you don't give one. Loose on purpose, so `req.params`,
 * `req.user` etc. work in loaders without casts. Pass your own type via `getUserId` or a
 * typed loader to get stricter checking.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RequestLike = { [key: string]: any };

export interface ResponseLike {
  status(code: number): { json(body: unknown): unknown };
}

export type NextFunction = (err?: unknown) => void;

/** Express-compatible middleware. Returns nothing; every error is passed to `next(err)`. */
export type Middleware<Req extends object = RequestLike> = (
  req: Req,
  res: ResponseLike,
  next: NextFunction,
) => void;

type OwnerId = UserId | null | undefined;

// Callbacks use method syntax so users can annotate `req` / `res` with their own Express types.
export interface GuardOptions<Req extends object = RequestLike> {
  /** Returns the current user's id. Default: `req.user?.id`. May be async. */
  getUserId?(req: Req): OwnerId | Promise<OwnerId>;
  /** No user. Default: 401 `{ "error": "Unauthorized" }`. */
  onUnauthenticated?(req: Req, res: ResponseLike): unknown;
  /** User lacks access. Default: 403 `{ "error": "Forbidden", "missing": [...] }`. */
  onDenied?(req: Req, res: ResponseLike, missing: string[]): unknown;
  /** `own()` loader returned null/undefined. Default: 404 `{ "error": "Not Found" }`. */
  onNotFound?(req: Req, res: ResponseLike): unknown;
}

export interface Guard<P extends string, R extends string, Req extends object> {
  /** Requires the permission. */
  permission(permission: P): Middleware<Req>;
  /** Requires at least one of the permissions. */
  anyPermission(permissions: readonly P[]): Middleware<Req>;
  /** Requires every permission. */
  allPermissions(permissions: readonly P[]): Middleware<Req>;
  /** Requires the role. `missing` in the 403 lists roles. */
  role(role: R): Middleware<Req>;
  anyRole(roles: readonly R[]): Middleware<Req>;
  allRoles(roles: readonly R[]): Middleware<Req>;
  /**
   * Allows the user if they have `permission`, or `permission + ".own"` and own the resource.
   * `getOwnerId` loads the resource's owner id; null/undefined means "not found" (404).
   */
  own<OwnReq extends Req = Req>(
    permission: P,
    getOwnerId: (req: OwnReq) => OwnerId | Promise<OwnerId>,
  ): Middleware<OwnReq>;
}

type Outcome = { allowed: true } | { allowed: false; missing: string[] } | { notFound: true };
type Check = (user: UserScope, req: RequestLike) => Promise<Outcome>;

const ALLOWED: Outcome = { allowed: true };

const DEFAULTS: Required<GuardOptions> = {
  getUserId: (req) => (req.user as { id?: OwnerId } | undefined)?.id,
  onUnauthenticated: (_req, res) => res.status(401).json({ error: "Unauthorized" }),
  onDenied: (_req, res, missing) => res.status(403).json({ error: "Forbidden", missing }),
  onNotFound: (_req, res) => res.status(404).json({ error: "Not Found" }),
};

/**
 * Creates route guards that share options.
 *
 * ```js
 * const guard = permlyExpress(perms, { getUserId: (req) => req.session.userId });
 * app.delete("/posts/:id", guard.permission("posts.delete"), handler);
 * ```
 */
export function permlyExpress<P extends string, R extends string, Req extends object = RequestLike>(
  perms: Permissions<P, R>,
  options: GuardOptions<Req> = {},
): Guard<P, R, Req> {
  assertPerms(perms);
  const settings = resolveOptions(options);

  function middleware(check: Check): Middleware<RequestLike> {
    async function run(req: RequestLike, res: ResponseLike): Promise<boolean> {
      const id = await settings.getUserId(req);
      if (id === undefined || id === null || id === "") {
        await settings.onUnauthenticated(req, res);
        return false;
      }
      const outcome = await check(perms.user(id) as UserScope, req);
      if ("notFound" in outcome) {
        await settings.onNotFound(req, res);
        return false;
      }
      if (!outcome.allowed) {
        await settings.onDenied(req, res, outcome.missing);
        return false;
      }
      return true;
    }

    // Express 4 ignores returned promises, so errors are always handed to next() here.
    return (req, res, next) => {
      run(req, res).then((passed) => {
        if (passed) next();
      }, next);
    };
  }

  const guard: Guard<string, string, RequestLike> = {
    permission(permission) {
      const names = [nameArg("permission", permission)];
      return middleware(async (user) => deniedUnless(await missingPermissions(user, names)));
    },

    anyPermission(permissions) {
      const names = listArg("anyPermission", permissions);
      return middleware(async (user) =>
        (await user.canAny(names)) ? ALLOWED : { allowed: false, missing: names },
      );
    },

    allPermissions(permissions) {
      const names = listArg("allPermissions", permissions);
      return middleware(async (user) => deniedUnless(await missingPermissions(user, names)));
    },

    role(role) {
      const names = [nameArg("role", role)];
      return middleware(async (user) => deniedUnless(await missingRoles(user, names)));
    },

    anyRole(roles) {
      const names = listArg("anyRole", roles);
      return middleware(async (user) =>
        (await user.hasAnyRole(names)) ? ALLOWED : { allowed: false, missing: names },
      );
    },

    allRoles(roles) {
      const names = listArg("allRoles", roles);
      return middleware(async (user) => deniedUnless(await missingRoles(user, names)));
    },

    own(permission, getOwnerId) {
      const name = nameArg("own", permission);
      if (typeof getOwnerId !== "function") {
        throw new InvalidInputError(
          `own("${name}", getOwnerId) needs a function that returns the resource owner's id.`,
        );
      }
      // The returned middleware is typed for OwnReq, so the loader only ever sees OwnReq requests.
      const loadOwnerId = getOwnerId as (req: RequestLike) => OwnerId | Promise<OwnerId>;
      return middleware(async (user, req) => {
        const ownerId = await loadOwnerId(req);
        if (ownerId === undefined || ownerId === null) return { notFound: true };
        return (await user.canOwn(name, ownerId)) ? ALLOWED : { allowed: false, missing: [name] };
      });
    },
  };

  return guard as unknown as Guard<P, R, Req>;
}

// The simple functions take names from the type of `perms` only (not from the name argument),
// so a typo is an error instead of silently widening the allowed names.
type AnyPermissions = Permissions<string, string>;
type PermissionOf<T> = T extends Permissions<infer P, string> ? P : never;
type RoleOf<T> = T extends Permissions<string, infer R> ? R : never;

/** Middleware requiring one permission. */
export function requirePermission<T extends AnyPermissions, Req extends object = RequestLike>(
  perms: T,
  permission: PermissionOf<T>,
  options?: GuardOptions<Req>,
): Middleware<Req> {
  return permlyExpress(perms, options).permission(permission as never);
}

/** Middleware requiring at least one of the permissions. */
export function requireAnyPermission<T extends AnyPermissions, Req extends object = RequestLike>(
  perms: T,
  permissions: readonly PermissionOf<T>[],
  options?: GuardOptions<Req>,
): Middleware<Req> {
  return permlyExpress(perms, options).anyPermission(permissions as never);
}

/** Middleware requiring every permission. */
export function requireAllPermissions<T extends AnyPermissions, Req extends object = RequestLike>(
  perms: T,
  permissions: readonly PermissionOf<T>[],
  options?: GuardOptions<Req>,
): Middleware<Req> {
  return permlyExpress(perms, options).allPermissions(permissions as never);
}

/** Middleware requiring a role. */
export function requireRole<T extends AnyPermissions, Req extends object = RequestLike>(
  perms: T,
  role: RoleOf<T>,
  options?: GuardOptions<Req>,
): Middleware<Req> {
  return permlyExpress(perms, options).role(role as never);
}

/** Middleware requiring at least one of the roles. */
export function requireAnyRole<T extends AnyPermissions, Req extends object = RequestLike>(
  perms: T,
  roles: readonly RoleOf<T>[],
  options?: GuardOptions<Req>,
): Middleware<Req> {
  return permlyExpress(perms, options).anyRole(roles as never);
}

/** Middleware requiring every role. */
export function requireAllRoles<T extends AnyPermissions, Req extends object = RequestLike>(
  perms: T,
  roles: readonly RoleOf<T>[],
  options?: GuardOptions<Req>,
): Middleware<Req> {
  return permlyExpress(perms, options).allRoles(roles as never);
}

// --- checks ---

async function missingPermissions(user: UserScope, names: string[]): Promise<string[]> {
  try {
    await user.authorize(names);
    return [];
  } catch (err) {
    if (isPermissionDeniedError(err)) return err.missing;
    throw err; // unknown names (strict mode), database errors, ... → next(err)
  }
}

async function missingRoles(user: UserScope, names: string[]): Promise<string[]> {
  const held = await Promise.all(names.map((name) => user.hasRole(name)));
  return names.filter((_, i) => !held[i]);
}

function deniedUnless(missing: string[]): Outcome {
  return missing.length === 0 ? ALLOWED : { allowed: false, missing };
}

// --- setup validation: runs when routes are defined, so mistakes fail at startup ---

function assertPerms(perms: unknown): void {
  if (typeof (perms as { user?: unknown } | null)?.user !== "function") {
    throw new InvalidInputError(
      `permly/express needs the object returned by createPermissions() as its first argument.`,
    );
  }
}

function resolveOptions(options: unknown): Required<GuardOptions> {
  if (typeof options !== "object" || options === null) {
    throw new InvalidInputError(`permly/express options must be an object.`);
  }
  const settings = { ...DEFAULTS };
  for (const [key, value] of Object.entries(options)) {
    if (!(key in DEFAULTS)) {
      throw new InvalidInputError(
        `Unknown permly/express option "${key}". Expected one of: ${Object.keys(DEFAULTS).join(", ")}.`,
      );
    }
    if (value === undefined) continue;
    if (typeof value !== "function") {
      throw new InvalidInputError(`permly/express option "${key}" must be a function.`);
    }
    (settings as Record<string, unknown>)[key] = value;
  }
  return settings;
}

function nameArg(method: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidInputError(`${method}() needs a name as a non-empty string.`);
  }
  return value;
}

function listArg(method: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidInputError(`${method}() needs a non-empty array of names.`);
  }
  return value.map((name) => nameArg(method, name));
}
