import { TtlCache } from "./cache";
import { PermissionNotFoundError, RoleNotFoundError } from "./errors";
import { buildGrants, wildcardsFor, type Grants } from "./resolve";
import { suggest } from "./similarity";
import { isWildcard, type ResolvedConfig } from "./validate";
import type { PermissionAdapter } from "./types";

export interface Catalog {
  roles: ReadonlySet<string>;
  /** Every stored permission, wildcard rows included. */
  permissions: ReadonlySet<string>;
}

/** Shared state behind a permissions instance: adapter, caches, and name validation. */
export class Engine {
  readonly adapter: PermissionAdapter;
  readonly strict: boolean;
  private readonly configRoles: ReadonlySet<string>;
  private readonly configPermissions: ReadonlySet<string>;
  private readonly catalogCache: TtlCache<Catalog>;
  private readonly grantsCache: TtlCache<Grants>;

  constructor(config: ResolvedConfig) {
    this.adapter = config.adapter;
    this.strict = config.strict;
    this.configRoles = new Set(config.roles);
    this.configPermissions = new Set(config.permissions);
    this.catalogCache = new TtlCache(config.ttlMs);
    this.grantsCache = new TtlCache(config.ttlMs);
  }

  catalog(): Promise<Catalog> {
    return this.catalogCache.getOrLoad("catalog", async () => {
      const [roles, permissions] = await Promise.all([
        this.adapter.listRoles(),
        this.adapter.listPermissions(),
      ]);
      return { roles: new Set(roles), permissions: new Set(permissions) };
    });
  }

  grants(userId: string): Promise<Grants> {
    return this.grantsCache.getOrLoad(userId, async () =>
      buildGrants(await this.adapter.getUserAccess(userId)),
    );
  }

  /** For changes: every role must exist. */
  async requireRoles(names: readonly string[]): Promise<void> {
    const { roles } = await this.catalog();
    const unknown = names.find((name) => !roles.has(name));
    if (unknown !== undefined) throw this.roleNotFound(unknown, roles);
  }

  /**
   * For grants and revokes: concrete names must exist, and wildcards must match at least one
   * existing permission. With `createWildcards`, missing wildcard rows are created.
   */
  async requirePermissions(names: readonly string[], createWildcards: boolean): Promise<void> {
    const { permissions } = await this.catalog();
    const validWildcards = wildcardsFor(permissions);
    const toCreate: string[] = [];
    for (const name of names) {
      if (isWildcard(name)) {
        if (!validWildcards.has(name)) {
          throw new PermissionNotFoundError(name, { suggestion: suggest(name, validWildcards) });
        }
        if (!permissions.has(name)) toCreate.push(name);
      } else if (!permissions.has(name)) {
        throw this.permissionNotFound(name, permissions);
      }
    }
    if (createWildcards && toCreate.length > 0) {
      await this.adapter.createPermissions(toCreate);
      this.invalidateAll();
    }
  }

  /** For checks: the names that exist. In strict mode an unknown name throws instead. */
  async knownRoles(names: readonly string[]): Promise<ReadonlySet<string>> {
    const { roles } = await this.catalog();
    return this.known(names, roles, (name) => this.roleNotFound(name, roles));
  }

  async knownPermissions(names: readonly string[]): Promise<ReadonlySet<string>> {
    const { permissions } = await this.catalog();
    return this.known(names, permissions, (name) => this.permissionNotFound(name, permissions));
  }

  invalidateUser(userId: string): void {
    this.grantsCache.delete(userId);
  }

  invalidateAll(): void {
    this.catalogCache.clear();
    this.grantsCache.clear();
  }

  private known(
    names: readonly string[],
    existing: ReadonlySet<string>,
    notFound: (name: string) => Error,
  ): ReadonlySet<string> {
    const found = new Set<string>();
    for (const name of names) {
      if (existing.has(name)) found.add(name);
      else if (this.strict) throw notFound(name);
    }
    return found;
  }

  private roleNotFound(name: string, roles: ReadonlySet<string>): RoleNotFoundError {
    return new RoleNotFoundError(name, {
      inConfig: this.configRoles.has(name),
      suggestion: suggest(name, roles),
    });
  }

  private permissionNotFound(name: string, permissions: ReadonlySet<string>) {
    const concrete = [...permissions].filter((p) => !isWildcard(p));
    return new PermissionNotFoundError(name, {
      inConfig: this.configPermissions.has(name),
      suggestion: suggest(name, concrete),
    });
  }
}
