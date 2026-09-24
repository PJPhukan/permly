import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  DEFAULT_PREFIX,
  DEFAULT_SCHEMA,
  validatePrefix,
  validateSchema,
} from "../adapters/sql-shared";
import { checkDatabase, DATABASES, SUPPORTED_DATABASES, UsageError, type Flags } from "./args";
import { detectProject, isInstalled, type Project } from "./detect";
import { out, print } from "./output";
import type { Prompter } from "./prompt";
import {
  DRIVERS,
  migrationSql,
  starterFile,
  type Database,
  type Language,
  type ModuleFormat,
} from "./templates";

interface PlannedFile {
  path: string;
  content: string;
}

export async function init(flags: Flags, prompter: Prompter | undefined, version: string) {
  const cwd = process.cwd();
  const project = detectProject(cwd);

  if (!prompter && flags.db === undefined) {
    throw new UsageError(
      `Missing --db. Without a terminal to ask in, pass it explicitly: permly init --db mysql (or --db postgres)`,
    );
  }

  print(out.bold("permly init"));
  print();
  if (!project.hasPackageJson) {
    print(out.yellow(`No package.json in ${cwd}. Run this from your project's root folder.`));
    print();
  }

  // Without a prompter, --db was checked above.
  const db: Database =
    flags.db !== undefined || !prompter
      ? checkDatabase(flags.db ?? "")
      : await askDatabase(prompter);
  if (db !== "postgres" && flags.schema !== undefined) {
    throw new UsageError("--schema is only used with Postgres (--db postgres).");
  }
  const prefix =
    flags.prefix !== undefined
      ? toUsage(() => validatePrefix(flags.prefix))
      : prompter
        ? await prompter.askValid("Table prefix?", DEFAULT_PREFIX, validatePrefix)
        : DEFAULT_PREFIX;
  const schema =
    db !== "postgres"
      ? DEFAULT_SCHEMA
      : flags.schema !== undefined
        ? toUsage(() => validateSchema(flags.schema))
        : prompter
          ? await prompter.askValid("Postgres schema?", DEFAULT_SCHEMA, validateSchema)
          : DEFAULT_SCHEMA;
  const outDir =
    flags.out ??
    (prompter ? await prompter.ask("Folder for the SQL migration?", "migrations") : "migrations");

  let language: Language = flags.ts ? "ts" : flags.js ? "js" : project.typescript ? "ts" : "js";
  let format: ModuleFormat = flags.esm ? "esm" : flags.cjs ? "cjs" : project.esm ? "esm" : "cjs";
  const { driver } = DRIVERS[db];
  const driverInstalled = isInstalled(cwd, driver);

  const where = db === "postgres" ? ` · schema ${schema}` : "";
  print(`  Using:    ${db}${where} · table prefix ${prefix} · SQL file in ${outDir}`);
  print(
    `  Detected: ${describeSetup(language, format)} · ${
      driverInstalled ? `${driver} installed` : out.yellow(`${driver} not installed`)
    }`,
  );
  const languageFromFlag = flags.ts || flags.js;
  const formatFromFlag = flags.esm || flags.cjs || language === "ts";
  if (prompter && !(languageFromFlag && formatFromFlag)) {
    if (!(await prompter.confirm("Use these settings?", true))) {
      if (!languageFromFlag) {
        language = await prompter.askValid("Language, ts or js?", language, (answer) =>
          oneOf(answer, ["ts", "js"]),
        );
      }
      if (language === "js" && !(flags.esm || flags.cjs)) {
        format = await prompter.askValid("Module format, esm or cjs?", format, (answer) =>
          oneOf(answer, ["esm", "cjs"]),
        );
      }
    }
  }

  const files: PlannedFile[] = [
    {
      path: migrationPath(resolve(cwd, outDir)),
      content: migrationSql(db, prefix, schema, version),
    },
    {
      path: join(cwd, project.hasSrcDir ? "src" : "", starterFileName(language, format, project)),
      content: starterFile({ db, language, format, prefix, schema }),
    },
  ];

  const toWrite = await decideOverwrites(files, flags.force, prompter, cwd);

  print();
  for (const file of files) {
    const shown = relative(cwd, file.path);
    if (!toWrite.includes(file)) {
      print(`  ${out.yellow("kept")}     ${shown} ${out.dim("(already exists)")}`);
      continue;
    }
    const existed = existsSync(file.path);
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
    print(`  ${out.green(existed ? "replaced" : "created")}  ${shown}`);
  }

  const [sqlFile, starter] = files.map((file) => relative(cwd, file.path)) as [string, string];
  printNextSteps({ db, sqlFile, starter, prefix, schema, driverInstalled });
}

async function askDatabase(prompter: Prompter): Promise<Database> {
  const labels = DATABASES.map((name, i) =>
    SUPPORTED_DATABASES.includes(name)
      ? `${i + 1}) ${name}`
      : out.dim(`${i + 1}) ${name} (coming soon)`),
  );
  print(`  ${labels.join("   ")}`);
  return prompter.askValid("Database?", "mysql", (answer) =>
    checkDatabase(DATABASES[Number(answer) - 1] ?? answer),
  );
}

/** Runs a validator on a flag value; its error becomes a usage error (exit code 2). */
function toUsage<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function oneOf<T extends string>(answer: string, options: T[]): T {
  const value = answer.toLowerCase() as T;
  if (!options.includes(value)) throw new Error(`Please answer ${options.join(" or ")}.`);
  return value;
}

function describeSetup(language: Language, format: ModuleFormat): string {
  if (language === "ts") return "TypeScript";
  return format === "esm" ? "JavaScript (ES modules)" : "JavaScript (CommonJS)";
}

/** Reuses an existing "*_permly_init.sql" so running init twice doesn't create two migrations. */
function migrationPath(dir: string): string {
  const existing = existsSync(dir)
    ? readdirSync(dir).find((name) => name.endsWith("_permly_init.sql"))
    : undefined;
  if (existing) return join(dir, existing);
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14); // YYYYMMDDHHMMSS, UTC
  return join(dir, `${stamp}_permly_init.sql`);
}

/** permly.ts, or permly.js / .mjs / .cjs so Node loads it with the chosen module format. */
function starterFileName(language: Language, format: ModuleFormat, project: Project): string {
  if (language === "ts") return "permly.ts";
  if (format === "esm") return project.esm ? "permly.js" : "permly.mjs";
  return project.esm ? "permly.cjs" : "permly.js";
}

async function decideOverwrites(
  files: PlannedFile[],
  force: boolean,
  prompter: Prompter | undefined,
  cwd: string,
): Promise<PlannedFile[]> {
  const existing = files.filter((file) => existsSync(file.path));
  if (force || existing.length === 0) return files;
  if (!prompter) {
    const list = existing.map((file) => `  ${relative(cwd, file.path)}`).join("\n");
    throw new Error(`These files already exist:\n${list}\nRe-run with --force to overwrite them.`);
  }
  const keep: PlannedFile[] = [];
  for (const file of existing) {
    if (
      !(await prompter.confirm(`${relative(cwd, file.path)} already exists. Overwrite?`, false))
    ) {
      keep.push(file);
    }
  }
  return files.filter((file) => !keep.includes(file));
}

function printNextSteps(options: {
  db: Database;
  sqlFile: string;
  starter: string;
  prefix: string;
  schema: string;
  driverInstalled: boolean;
}) {
  const { db, sqlFile, starter, prefix, schema, driverInstalled } = options;
  const { driver, label, urlExample } = DRIVERS[db];
  const steps: string[] = [];
  if (!driverInstalled) {
    steps.push(`Install the ${label} driver:\n       ${out.cyan(`npm install ${driver}`)}`);
  }
  const flags = [
    prefix === DEFAULT_PREFIX ? "" : ` --prefix ${prefix}`,
    schema === DEFAULT_SCHEMA ? "" : ` --schema ${schema}`,
  ].join("");
  steps.push(
    `Create the tables. Set DATABASE_URL (${urlExample}), then:\n` +
      `       ${out.cyan(`npx permly migrate${flags}`)}\n` +
      `     ${out.dim(`or run ${sqlFile} with your own migration tool.`)}`,
  );
  steps.push(
    `At startup, before handling requests:\n       ${out.cyan("await setupPermissions();")} ${out.dim(`// from ${starter}`)}`,
  );
  steps.push(`Protect routes: see the examples at the end of ${starter}.`);

  print();
  print(out.bold("Next steps"));
  steps.forEach((step, i) => print(`  ${i + 1}. ${step}`));
}
