import { Engine } from "./engine";
import { createRoleScope } from "./role-scope";
import type { Permissions, PermissionsConfig } from "./types";
import { createUserScope } from "./user-scope";
import {
  assertName,
  assertPermissionPattern,
  nameArgs,
  normalizeUserId,
  validateConfig,
} from "./validate";

export function createPermissions<const P extends string = string, const R extends string = string>(
  config: PermissionsConfig<P, R>,
): Permissions<P, R> {
  const resolved = validateConfig(config);
  const engine = new Engine(resolved);
  const { adapter } = engine;

  const permissions: Permissions = {
    async sync() {
      const [roles, perms] = await Promise.all([adapter.listRoles(), adapter.listPermissions()]);
      const existingRoles = new Set(roles);
      const existingPerms = new Set(perms);
      const createdRoles = resolved.roles.filter((name) => !existingRoles.has(name));
      const createdPermissions = resolved.permissions.filter((name) => !existingPerms.has(name));
      if (createdRoles.length > 0) await adapter.createRoles(createdRoles);
      if (createdPermissions.length > 0) await adapter.createPermissions(createdPermissions);
      engine.invalidateAll();
      return { createdRoles, createdPermissions };
    },

    user: (id) => createUserScope(engine, normalizeUserId(id)),

    role: (name) => createRoleScope(engine, assertName("Role", name)),

    async createRole(...names) {
      await adapter.createRoles(nameArgs("Role", "createRole", names));
      engine.invalidateAll();
    },

    async createPermission(...names) {
      await adapter.createPermissions(nameArgs("Permission", "createPermission", names));
      engine.invalidateAll();
    },

    async deleteRole(name) {
      const role = assertName("Role", name);
      await engine.requireRoles([role]);
      await adapter.deleteRole(role);
      engine.invalidateAll();
    },

    async deletePermission(name) {
      const permission = assertPermissionPattern(name);
      const { permissions: existing } = await engine.catalog();
      if (!existing.has(permission)) await engine.requirePermissions([permission], false);
      await adapter.deletePermission(permission);
      engine.invalidateAll();
    },

    async getAllRoles() {
      return [...(await engine.catalog()).roles].sort();
    },

    async getAllPermissions() {
      return [...(await engine.catalog()).permissions].sort();
    },

    clearCache: () => engine.invalidateAll(),
  };

  return permissions as Permissions<P, R>;
}
