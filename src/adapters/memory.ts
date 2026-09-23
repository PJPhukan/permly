import type { PermissionAdapter, UserAccess } from "../core/types";

/**
 * Keeps everything in process memory. Data is lost on restart.
 * Meant for tests, demos and prototypes.
 */
export function memoryAdapter(): PermissionAdapter {
  const roles = new Map<string, Set<string>>(); // role → its permissions
  const permissions = new Set<string>();
  const userRoles = new Map<string, Set<string>>();
  const userPermissions = new Map<string, Set<string>>();

  function linksFor(map: Map<string, Set<string>>, key: string): Set<string> {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    return set;
  }

  function addExisting(
    target: Set<string>,
    names: string[],
    existing: { has(n: string): boolean },
  ) {
    for (const name of names) if (existing.has(name)) target.add(name);
  }

  function removeAll(target: Set<string> | undefined, names: string[]) {
    for (const name of names) target?.delete(name);
  }

  return {
    async listRoles() {
      return [...roles.keys()];
    },

    async listPermissions() {
      return [...permissions];
    },

    async createRoles(names) {
      for (const name of names) if (!roles.has(name)) roles.set(name, new Set());
    },

    async createPermissions(names) {
      for (const name of names) permissions.add(name);
    },

    async deleteRole(name) {
      roles.delete(name);
      for (const set of userRoles.values()) set.delete(name);
    },

    async deletePermission(name) {
      permissions.delete(name);
      for (const set of roles.values()) set.delete(name);
      for (const set of userPermissions.values()) set.delete(name);
    },

    async getRolePermissions(role) {
      return [...(roles.get(role) ?? [])];
    },

    async addRolePermissions(role, names) {
      const set = roles.get(role);
      if (set) addExisting(set, names, permissions);
    },

    async removeRolePermissions(role, names) {
      removeAll(roles.get(role), names);
    },

    async setRolePermissions(role, names) {
      const set = roles.get(role);
      if (!set) return;
      set.clear();
      addExisting(set, names, permissions);
    },

    async getUserAccess(userId): Promise<UserAccess> {
      const assigned = [...(userRoles.get(userId) ?? [])];
      return {
        roles: assigned,
        rolePermissions: assigned.flatMap((role) => [...(roles.get(role) ?? [])]),
        directPermissions: [...(userPermissions.get(userId) ?? [])],
      };
    },

    async addUserRoles(userId, names) {
      addExisting(linksFor(userRoles, userId), names, roles);
    },

    async removeUserRoles(userId, names) {
      removeAll(userRoles.get(userId), names);
    },

    async setUserRoles(userId, names) {
      const set = linksFor(userRoles, userId);
      set.clear();
      addExisting(set, names, roles);
    },

    async addUserPermissions(userId, names) {
      addExisting(linksFor(userPermissions, userId), names, permissions);
    },

    async removeUserPermissions(userId, names) {
      removeAll(userPermissions.get(userId), names);
    },
  };
}
