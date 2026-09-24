// The single source of the Postgres schema. Used by the adapter's tests, the CLI's
// migration generator and `postgresSchema()` for users who run it themselves.
import {
  DEFAULT_PREFIX,
  DEFAULT_SCHEMA,
  tableNames,
  validatePrefix,
  validateSchema,
  type TableNames,
} from "./sql-shared";

/**
 * Schema-qualified, quoted table names such as "public"."perm_roles". Always qualified, so
 * permly never depends on the connection's search_path. Quoted names are case-sensitive.
 */
export function postgresTables(
  prefix: string = DEFAULT_PREFIX,
  schema: string = DEFAULT_SCHEMA,
): TableNames {
  const quotedSchema = `"${validateSchema(schema)}"`;
  return tableNames(validatePrefix(prefix), (name) => `${quotedSchema}."${name}"`);
}

export interface TablePlan {
  /** Unquoted table name, e.g. perm_roles. */
  table: string;
  statements: string[];
}

/** Statements grouped by table, in dependency order. Every statement is safe to re-run. */
export function postgresSchemaPlan(
  prefix: string = DEFAULT_PREFIX,
  schema: string = DEFAULT_SCHEMA,
): TablePlan[] {
  const p = validatePrefix(prefix);
  const t = postgresTables(p, schema);
  // Index names live in the schema, so they carry the prefix; kept short to stay under 63 chars.
  const index = (name: string, table: string, column: string) =>
    `CREATE INDEX IF NOT EXISTS "${p}${name}" ON ${table} ("${column}")`;
  const catalog = (table: string) => `CREATE TABLE IF NOT EXISTS ${table} (
  "id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "name" VARCHAR(150) NOT NULL UNIQUE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

  return [
    { table: `${p}roles`, statements: [catalog(t.roles)] },
    { table: `${p}permissions`, statements: [catalog(t.permissions)] },
    {
      table: `${p}role_permissions`,
      statements: [
        `CREATE TABLE IF NOT EXISTS ${t.rolePermissions} (
  "role_id" INT NOT NULL REFERENCES ${t.roles} ("id") ON DELETE CASCADE,
  "permission_id" INT NOT NULL REFERENCES ${t.permissions} ("id") ON DELETE CASCADE,
  PRIMARY KEY ("role_id", "permission_id")
)`,
        index("rp_permission_idx", t.rolePermissions, "permission_id"),
      ],
    },
    {
      // team_id is reserved for team support; '' means "no team" (a NULL can't be in a primary key).
      table: `${p}user_roles`,
      statements: [
        `CREATE TABLE IF NOT EXISTS ${t.userRoles} (
  "user_id" VARCHAR(64) NOT NULL,
  "team_id" VARCHAR(64) NOT NULL DEFAULT '',
  "role_id" INT NOT NULL REFERENCES ${t.roles} ("id") ON DELETE CASCADE,
  PRIMARY KEY ("user_id", "team_id", "role_id")
)`,
        index("ur_role_idx", t.userRoles, "role_id"),
      ],
    },
    {
      table: `${p}user_permissions`,
      statements: [
        `CREATE TABLE IF NOT EXISTS ${t.userPermissions} (
  "user_id" VARCHAR(64) NOT NULL,
  "team_id" VARCHAR(64) NOT NULL DEFAULT '',
  "permission_id" INT NOT NULL REFERENCES ${t.permissions} ("id") ON DELETE CASCADE,
  PRIMARY KEY ("user_id", "team_id", "permission_id")
)`,
        index("up_permission_idx", t.userPermissions, "permission_id"),
      ],
    },
  ];
}

/** CREATE TABLE / CREATE INDEX statements, one per entry. Safe to re-run (IF NOT EXISTS). */
export function postgresSchemaStatements(
  prefix: string = DEFAULT_PREFIX,
  schema: string = DEFAULT_SCHEMA,
): string[] {
  return postgresSchemaPlan(prefix, schema).flatMap((plan) => plan.statements);
}

/** The full schema as one SQL script. The schema itself must already exist. */
export function postgresSchema(
  prefix: string = DEFAULT_PREFIX,
  schema: string = DEFAULT_SCHEMA,
): string {
  return postgresSchemaStatements(prefix, schema).join(";\n\n") + ";\n";
}
