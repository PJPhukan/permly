// The single source of the MySQL/MariaDB schema. Used by the adapter's tests, the CLI's
// migration generator and `mysqlSchema()` for users who run it themselves.
import { DEFAULT_PREFIX, tableNames, validatePrefix, type TableNames } from "./sql-shared";

export function mysqlTables(prefix: string = DEFAULT_PREFIX): TableNames {
  return tableNames(validatePrefix(prefix), (name) => `\`${name}\``);
}

// utf8mb4_bin on every table makes names and user ids case-sensitive, matching the other adapters.
const TABLE_OPTIONS = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin";

/** CREATE TABLE statements, in dependency order. Safe to re-run (IF NOT EXISTS). */
export function mysqlSchemaStatements(prefix: string = DEFAULT_PREFIX): string[] {
  const t = mysqlTables(prefix);
  const catalogTable = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`name\` VARCHAR(150) NOT NULL,
  \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`name_unique\` (\`name\`)
) ${TABLE_OPTIONS}`;

  return [
    catalogTable(t.roles),
    catalogTable(t.permissions),
    `CREATE TABLE IF NOT EXISTS ${t.rolePermissions} (
  \`role_id\` INT UNSIGNED NOT NULL,
  \`permission_id\` INT UNSIGNED NOT NULL,
  PRIMARY KEY (\`role_id\`, \`permission_id\`),
  KEY \`permission_id_index\` (\`permission_id\`),
  FOREIGN KEY (\`role_id\`) REFERENCES ${t.roles} (\`id\`) ON DELETE CASCADE,
  FOREIGN KEY (\`permission_id\`) REFERENCES ${t.permissions} (\`id\`) ON DELETE CASCADE
) ${TABLE_OPTIONS}`,
    // team_id is reserved for team support; '' means "no team" (a NULL can't be part of a primary key).
    `CREATE TABLE IF NOT EXISTS ${t.userRoles} (
  \`user_id\` VARCHAR(64) NOT NULL,
  \`team_id\` VARCHAR(64) NOT NULL DEFAULT '',
  \`role_id\` INT UNSIGNED NOT NULL,
  PRIMARY KEY (\`user_id\`, \`team_id\`, \`role_id\`),
  KEY \`role_id_index\` (\`role_id\`),
  FOREIGN KEY (\`role_id\`) REFERENCES ${t.roles} (\`id\`) ON DELETE CASCADE
) ${TABLE_OPTIONS}`,
    `CREATE TABLE IF NOT EXISTS ${t.userPermissions} (
  \`user_id\` VARCHAR(64) NOT NULL,
  \`team_id\` VARCHAR(64) NOT NULL DEFAULT '',
  \`permission_id\` INT UNSIGNED NOT NULL,
  PRIMARY KEY (\`user_id\`, \`team_id\`, \`permission_id\`),
  KEY \`permission_id_index\` (\`permission_id\`),
  FOREIGN KEY (\`permission_id\`) REFERENCES ${t.permissions} (\`id\`) ON DELETE CASCADE
) ${TABLE_OPTIONS}`,
  ];
}

/** The full schema as one SQL script. */
export function mysqlSchema(prefix: string = DEFAULT_PREFIX): string {
  return mysqlSchemaStatements(prefix).join(";\n\n") + ";\n";
}
