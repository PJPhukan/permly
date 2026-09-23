import type { Engine } from "./engine";
import { expandPermissions } from "./resolve";
import type { RoleScope } from "./types";
import { readExpand } from "./user-scope";
import { nameArgs, nameList } from "./validate";

// Changing a role's permissions affects every user with that role, so the whole cache is cleared.
export function createRoleScope(engine: Engine, role: string): RoleScope {
  const { adapter } = engine;

  return {
    async givePermission(...permissions) {
      const names = nameArgs("Permission", "givePermission", permissions, { allowWildcard: true });
      await engine.requireRoles([role]);
      await engine.requirePermissions(names, true);
      await adapter.addRolePermissions(role, names);
      engine.invalidateAll();
    },

    async revokePermission(...permissions) {
      const names = nameArgs("Permission", "revokePermission", permissions, {
        allowWildcard: true,
      });
      await engine.requireRoles([role]);
      await engine.requirePermissions(names, false);
      await adapter.removeRolePermissions(role, names);
      engine.invalidateAll();
    },

    async syncPermissions(permissions) {
      const names = nameList("Permission", "syncPermissions", permissions, {
        allowWildcard: true,
        allowEmpty: true,
      });
      await engine.requireRoles([role]);
      await engine.requirePermissions(names, true);
      await adapter.setRolePermissions(role, names);
      engine.invalidateAll();
    },

    async getPermissions(options) {
      const expand = readExpand(options);
      await engine.requireRoles([role]);
      const stored = [...new Set(await adapter.getRolePermissions(role))].sort();
      if (!expand) return stored;
      return expandPermissions(stored, (await engine.catalog()).permissions);
    },
  };
}
