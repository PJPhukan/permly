/** A user id: integer, string (e.g. UUID), or a Mongo ObjectId. Stored as a string. */
export type UserId = string | number | { toHexString(): string };

/** Extract the permission type P from `typeof perms`. Example: `type Permission = InferPermission<typeof perms>` */
export type InferPermission<T> = T extends Permissions<infer P, any> ? P : never;

/** Extract the role type R from `typeof perms`. Example: `type Role = InferRole<typeof perms>` */
export type InferRole<T> = T extends Permissions<any, infer R> ? R : never;

// Depth counter for Wildcard: at most 5 prefix levels ("a.*" … "a.b.c.d.e.*") are typed, which
// keeps type-checking fast for large configs. Deeper wildcards still work at runtime.
type Prev = [never, 0, 1, 2, 3, 4];

type WildcardParts<S extends string, D extends number> = [D] extends [never]
  ? never
  : S extends `${infer Head}.${infer Rest}`
    ? `${Head}.*` | `${Head}.${WildcardParts<Rest, Prev[D]>}`
    : never;

/**
 * Wildcards that can be granted for a set of permission names.
 * `"posts.edit.own"` allows `"*"`, `"posts.*"` and `"posts.edit.*"`.
 */
export type Wildcard<P extends string> = "*" | WildcardParts<P, 4>;

/** What an adapter returns for one user. Core merges and caches it. */
export interface UserAccess {
  roles: string[];
  /** Permissions from all of the user's roles (duplicates allowed). */
  rolePermissions: string[];
  /** Permissions given to the user directly. */
  directPermissions: string[];
}

/**
 * Storage layer. Adapters work with names, not ids, and contain no permission logic:
 * core validates names before calling them and does all merging, matching and caching.
 *
 * Contract:
 * - `create*` and `add*` are idempotent (existing rows are ignored).
 * - `add*`, `remove*` and `set*` may silently ignore names that do not exist.
 * - `delete*` cascades to every link (role ↔ permission, user ↔ role, user ↔ permission).
 * - `set*` replaces the whole list, atomically where the database allows.
 */
export interface PermissionAdapter {
  listRoles(): Promise<string[]>;
  listPermissions(): Promise<string[]>;
  createRoles(names: string[]): Promise<void>;
  createPermissions(names: string[]): Promise<void>;
  deleteRole(name: string): Promise<void>;
  deletePermission(name: string): Promise<void>;

  getRolePermissions(role: string): Promise<string[]>;
  addRolePermissions(role: string, permissions: string[]): Promise<void>;
  removeRolePermissions(role: string, permissions: string[]): Promise<void>;
  setRolePermissions(role: string, permissions: string[]): Promise<void>;

  getUserAccess(userId: string): Promise<UserAccess>;
  addUserRoles(userId: string, roles: string[]): Promise<void>;
  removeUserRoles(userId: string, roles: string[]): Promise<void>;
  setUserRoles(userId: string, roles: string[]): Promise<void>;
  addUserPermissions(userId: string, permissions: string[]): Promise<void>;
  removeUserPermissions(userId: string, permissions: string[]): Promise<void>;
}

export interface CacheOptions {
  /** Seconds a user's roles/permissions stay cached. Default 60. `0` disables caching. */
  ttl?: number;
}

export interface PermissionsConfig<P extends string, R extends string> {
  adapter: PermissionAdapter;
  /** In-process cache. On by default (60s). Pass `false` to disable. */
  cache?: CacheOptions | false;
  /** Permission names created by `sync()`. Also gives TypeScript autocomplete. */
  permissions?: readonly P[];
  /** Role names created by `sync()`. Also gives TypeScript autocomplete. */
  roles?: readonly R[];
  /**
   * When true (default), checks like `can()` and `hasRole()` throw for names that don't exist,
   * so typos surface early. When false, they return `false` instead.
   */
  strict?: boolean;
}

export interface GetPermissionsOptions {
  /** Replace wildcards like `"posts.*"` with the concrete permissions they match. */
  expand?: boolean;
}

export interface SyncResult {
  createdRoles: string[];
  createdPermissions: string[];
}

export interface Permissions<P extends string = string, R extends string = string> {
  /** Creates the roles and permissions listed in config if missing. Never deletes. Safe on every start. */
  sync(): Promise<SyncResult>;
  /** Scope for one user. Synchronous, does not touch the database. */
  user(id: UserId): UserScope<P, R>;
  /** Scope for one role. Synchronous, does not touch the database. */
  role(name: R): RoleScope<P>;

  /** Creates roles. Existing ones are ignored. */
  createRole(...names: string[]): Promise<void>;
  /** Creates permissions. Existing ones are ignored. Wildcards are created automatically when granted. */
  createPermission(...names: string[]): Promise<void>;
  /** Deletes a role and removes it from every user. */
  deleteRole(name: R): Promise<void>;
  /** Deletes a permission and removes it from every role and user. */
  deletePermission(name: P | Wildcard<P>): Promise<void>;
  getAllRoles(): Promise<string[]>;
  getAllPermissions(): Promise<string[]>;

  /** Empties the in-process cache. Changes made through this instance already do this. */
  clearCache(): void;

  /** Type guard: returns true if value is a configured permission name. Never throws. */
  isPermission(value: unknown): value is P;
  /** Type guard: returns true if value is a configured role name. Never throws. */
  isRole(value: unknown): value is R;
}

export interface RoleScope<P extends string = string> {
  givePermission(...permissions: (P | Wildcard<P>)[]): Promise<void>;
  revokePermission(...permissions: (P | Wildcard<P>)[]): Promise<void>;
  /** Replaces all of the role's permissions with this list. */
  syncPermissions(permissions: readonly (P | Wildcard<P>)[]): Promise<void>;
  getPermissions(options?: GetPermissionsOptions): Promise<string[]>;
}

export interface UserScope<P extends string = string, R extends string = string> {
  assignRole(...roles: R[]): Promise<void>;
  removeRole(...roles: R[]): Promise<void>;
  /** Replaces all of the user's roles with this list. */
  syncRoles(roles: readonly R[]): Promise<void>;
  /** Gives a permission directly to the user, independent of roles. */
  givePermission(...permissions: (P | Wildcard<P>)[]): Promise<void>;
  revokePermission(...permissions: (P | Wildcard<P>)[]): Promise<void>;

  can(permission: P): Promise<boolean>;
  canAny(permissions: readonly P[]): Promise<boolean>;
  canAll(permissions: readonly P[]): Promise<boolean>;
  /**
   * True if the user has `permission`, or has `permission + ".own"` and owns the resource.
   * `canOwn("posts.edit", post.userId)` checks "posts.edit" and "posts.edit.own".
   */
  canOwn(permission: P, ownerId: UserId | null | undefined): Promise<boolean>;
  /** Throws PermissionDeniedError (with `.missing`) unless the user has every permission. */
  authorize(permission: P | readonly P[]): Promise<void>;
  hasRole(role: R): Promise<boolean>;
  hasAnyRole(roles: readonly R[]): Promise<boolean>;
  hasAllRoles(roles: readonly R[]): Promise<boolean>;
  getRoles(): Promise<string[]>;
  /** Role and direct permissions merged, as stored (wildcards included unless `expand`). */
  getPermissions(options?: GetPermissionsOptions): Promise<string[]>;
}
