import type { Engine } from "./engine";
import { InvalidInputError, PermissionDeniedError } from "./errors";
import { expandPermissions, isGranted } from "./resolve";
import type { GetPermissionsOptions, UserScope } from "./types";
import { assertName, describe, nameArgs, nameList, normalizeUserId } from "./validate";

export function createUserScope(engine: Engine, userId: string): UserScope {
  const { adapter } = engine;

  /** Permissions from `names` the user does not have. Unknown names count as missing when not strict. */
  async function missing(names: string[]): Promise<string[]> {
    const [known, grants] = await Promise.all([
      engine.knownPermissions(names),
      engine.grants(userId),
    ]);
    return names.filter((name) => !known.has(name) || !isGranted(grants, name));
  }

  async function heldRoles(roles: string[]): Promise<boolean[]> {
    const [known, grants] = await Promise.all([engine.knownRoles(roles), engine.grants(userId)]);
    return roles.map((role) => known.has(role) && grants.roles.has(role));
  }

  return {
    async assignRole(...roles) {
      const names = nameArgs("Role", "assignRole", roles);
      await engine.requireRoles(names);
      await adapter.addUserRoles(userId, names);
      engine.invalidateUser(userId);
    },

    async removeRole(...roles) {
      const names = nameArgs("Role", "removeRole", roles);
      await engine.requireRoles(names);
      await adapter.removeUserRoles(userId, names);
      engine.invalidateUser(userId);
    },

    async syncRoles(roles) {
      const names = nameList("Role", "syncRoles", roles, { allowEmpty: true });
      await engine.requireRoles(names);
      await adapter.setUserRoles(userId, names);
      engine.invalidateUser(userId);
    },

    async givePermission(...permissions) {
      const names = nameArgs("Permission", "givePermission", permissions, { allowWildcard: true });
      await engine.requirePermissions(names, true);
      await adapter.addUserPermissions(userId, names);
      engine.invalidateUser(userId);
    },

    async revokePermission(...permissions) {
      const names = nameArgs("Permission", "revokePermission", permissions, {
        allowWildcard: true,
      });
      await engine.requirePermissions(names, false);
      await adapter.removeUserPermissions(userId, names);
      engine.invalidateUser(userId);
    },

    async can(permission) {
      const name = assertName("Permission", permission);
      return (await missing([name])).length === 0;
    },

    async canAny(permissions) {
      const names = nameList("Permission", "canAny", permissions);
      return (await missing(names)).length < names.length;
    },

    async canAll(permissions) {
      const names = nameList("Permission", "canAll", permissions);
      return (await missing(names)).length === 0;
    },

    async canOwn(permission, ownerId) {
      const name = assertName("Permission", permission);
      const owner =
        ownerId === null || ownerId === undefined
          ? undefined
          : normalizeUserId(ownerId, "Owner id");

      if ((await missing([name])).length === 0) return true;
      if (owner !== userId) return false;

      // The ".own" variant is optional: if it was never created, only the base permission counts.
      const own = `${name}.own`;
      const [{ permissions }, grants] = await Promise.all([
        engine.catalog(),
        engine.grants(userId),
      ]);
      return permissions.has(own) && isGranted(grants, own);
    },

    async authorize(permission) {
      const names = Array.isArray(permission)
        ? nameList("Permission", "authorize", permission)
        : [assertName("Permission", permission)];
      const denied = await missing(names);
      if (denied.length > 0) throw new PermissionDeniedError(denied);
    },

    async hasRole(role) {
      const [held] = await heldRoles([assertName("Role", role)]);
      return held === true;
    },

    async hasAnyRole(roles) {
      return (await heldRoles(nameList("Role", "hasAnyRole", roles))).some(Boolean);
    },

    async hasAllRoles(roles) {
      return (await heldRoles(nameList("Role", "hasAllRoles", roles))).every(Boolean);
    },

    async getRoles() {
      return [...(await engine.grants(userId)).roles].sort();
    },

    async getPermissions(options) {
      const expand = readExpand(options);
      const grants = await engine.grants(userId);
      if (!expand) return [...grants.permissions];
      return expandPermissions(grants.permissions, (await engine.catalog()).permissions);
    },
  };
}

export function readExpand(options: GetPermissionsOptions | undefined): boolean {
  if (options === undefined) return false;
  if (typeof options !== "object" || options === null) {
    throw new InvalidInputError(
      `getPermissions() options must be an object like { expand: true }, got ${describe(options)}.`,
    );
  }
  if (options.expand !== undefined && typeof options.expand !== "boolean") {
    throw new InvalidInputError(`getPermissions() option "expand" must be true or false.`);
  }
  return options.expand === true;
}
