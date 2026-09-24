// The single description of permly's MongoDB collections and indexes. Used by the adapter to
// check they exist, by `npx permly migrate` to create them, and by the generated setup script.
import { DEFAULT_PREFIX, validatePrefix } from "./sql-shared";

export interface MongoIndexSpec {
  name: string;
  key: Record<string, 1>;
  unique?: boolean;
  /** TTL index: documents are removed once this many seconds past the indexed date. */
  expireAfterSeconds?: number;
}

export interface MongoCollectionSpec {
  /** Full collection name, prefix included. */
  name: string;
  indexes: MongoIndexSpec[];
}

export interface MongoCollectionNames {
  roles: string;
  permissions: string;
  rolePermissions: string;
  userRoles: string;
  userPermissions: string;
  /** Lease locks for syncRoles / syncPermissions. */
  locks: string;
}

export function mongodbCollections(prefix: string = DEFAULT_PREFIX): MongoCollectionNames {
  const p = validatePrefix(prefix);
  return {
    roles: `${p}roles`,
    permissions: `${p}permissions`,
    rolePermissions: `${p}role_permissions`,
    userRoles: `${p}user_roles`,
    userPermissions: `${p}user_permissions`,
    locks: `${p}locks`,
  };
}

/**
 * Collections and indexes permly needs, in creation order. No collation is set, so string
 * comparisons are MongoDB's default binary ones: names and user ids are case-sensitive.
 *
 * The unique link indexes start with user_id (or role_id), so they also serve lookups by
 * user; no separate user_id index is needed. team_id is reserved for team support; ""
 * means "no team", and it is part of the unique key.
 */
export function mongodbSetup(prefix: string = DEFAULT_PREFIX): MongoCollectionSpec[] {
  const c = mongodbCollections(prefix);
  const nameUnique: MongoIndexSpec = { name: "name_unique", key: { name: 1 }, unique: true };
  return [
    { name: c.roles, indexes: [nameUnique] },
    { name: c.permissions, indexes: [nameUnique] },
    {
      name: c.rolePermissions,
      indexes: [
        { name: "link_unique", key: { role_id: 1, permission_id: 1 }, unique: true },
        { name: "permission_id", key: { permission_id: 1 } },
      ],
    },
    {
      name: c.userRoles,
      indexes: [
        { name: "link_unique", key: { user_id: 1, team_id: 1, role_id: 1 }, unique: true },
        { name: "role_id", key: { role_id: 1 } },
      ],
    },
    {
      name: c.userPermissions,
      indexes: [
        { name: "link_unique", key: { user_id: 1, team_id: 1, permission_id: 1 }, unique: true },
        { name: "permission_id", key: { permission_id: 1 } },
      ],
    },
    {
      // Expired lease locks are also taken over directly; this TTL index only cleans up.
      name: c.locks,
      indexes: [{ name: "expires_ttl", key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
    },
  ];
}
