import { parseArgs } from "node:util";

/** Wrong flags or missing input: exit code 2. */
export class UsageError extends Error {}

/** The user cancelled a prompt (answered no, Ctrl+C or Ctrl+D): exit code 1. */
export class CancelledError extends Error {
  constructor(message = "Cancelled.") {
    super(message);
  }
}

export interface Flags {
  db: string | undefined;
  prefix: string | undefined;
  out: string | undefined;
  schema: string | undefined;
  url: string | undefined;
  ts: boolean;
  js: boolean;
  esm: boolean;
  cjs: boolean;
  force: boolean;
  yes: boolean;
  help: boolean;
  version: boolean;
}

export const DATABASES = ["mysql", "postgres", "mongodb"] as const;
export const SUPPORTED_DATABASES = ["mysql", "postgres"];

const ALIASES: Record<string, string> = {
  mariadb: "mysql",
  postgresql: "postgres",
  pg: "postgres",
};

export function parseCommandLine(argv: string[]): { command: string | undefined; flags: Flags } {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        db: { type: "string" },
        prefix: { type: "string" },
        out: { type: "string" },
        schema: { type: "string" },
        url: { type: "string" },
        ts: { type: "boolean", default: false },
        js: { type: "boolean", default: false },
        esm: { type: "boolean", default: false },
        cjs: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        yes: { type: "boolean", short: "y", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    // parseArgs messages are long; keep the first sentence.
    const message = error instanceof Error ? error.message.split(". ")[0] : String(error);
    throw new UsageError(`${message}.`);
  }

  const { values, positionals } = parsed;
  const [command, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError(`Unexpected argument "${extra[0]}".`);
  if (values.ts && values.js) throw new UsageError("Use either --ts or --js, not both.");
  if (values.esm && values.cjs) throw new UsageError("Use either --esm or --cjs, not both.");

  return {
    command,
    flags: {
      db: values.db,
      prefix: values.prefix,
      out: values.out,
      schema: values.schema,
      url: values.url,
      ts: values.ts,
      js: values.js,
      esm: values.esm,
      cjs: values.cjs,
      force: values.force,
      yes: values.yes,
      help: values.help,
      version: values.version,
    },
  };
}

/** Validates a --db value (or a prompt answer). */
export function checkDatabase(value: string): "mysql" | "postgres" {
  const input = value.trim().toLowerCase();
  const db = ALIASES[input] ?? input;
  if (!(DATABASES as readonly string[]).includes(db)) {
    throw new UsageError(`Unknown database "${value}". Use one of: ${DATABASES.join(", ")}.`);
  }
  if (!SUPPORTED_DATABASES.includes(db)) {
    throw new UsageError(
      `${db} support is coming soon. For now, permly init supports: ${SUPPORTED_DATABASES.join(", ")}.`,
    );
  }
  return db as "mysql" | "postgres";
}
