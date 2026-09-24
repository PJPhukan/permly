#!/usr/bin/env node
// The `permly` command. A separate bin entry: nothing in the library imports it.
import { readFileSync } from "node:fs";
import { CancelledError, parseCommandLine, UsageError, type Flags } from "./args";
import { init } from "./init";
import { migrate, urlSecrets } from "./migrate";
import { out, print, printError } from "./output";
import { Prompter } from "./prompt";

const HELP = `${out.bold("permly")} - roles & permissions for Node.js

${out.bold("Usage")}
  npx permly init       Create the migration file and a starter src/permly.(js|ts)
  npx permly migrate    Create the tables / collections in DATABASE_URL (skips existing ones)

${out.bold("Options")}
  --db <name>        Database: mysql, postgres or mongodb
  --prefix <prefix>  Table prefix (default: perm_)
  --out <dir>        init: folder for the migration file (default: migrations)
  --schema <name>    Postgres schema for the tables (default: public)
  --ts, --js         init: language of the starter file (default: detected)
  --esm, --cjs       init: module format of a JavaScript starter file (default: detected)
  --force            init: overwrite existing files
  --url <url>        migrate: database URL (default: $DATABASE_URL)
  -y, --yes          migrate: don't ask for confirmation
  -h, --help         Show this help
  -v, --version      Show the version

Without a terminal (e.g. in CI), permly never prompts: pass --db for init and --yes for
migrate, other values fall back to their defaults.

Exit codes: 0 success, 1 error or cancelled, 2 invalid usage.`;

function readVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

async function main(argv: string[]): Promise<number> {
  let flags: Flags | undefined;
  let secrets: string[] = [];
  let prompter: Prompter | undefined;
  const scrub = (text: string) =>
    secrets.reduce((result, secret) => result.split(secret).join("****"), text);

  try {
    const parsed = parseCommandLine(argv);
    flags = parsed.flags;
    secrets = urlSecrets(flags.url ?? process.env.DATABASE_URL);

    if (flags.version) {
      print(readVersion());
      return 0;
    }
    if (flags.help) {
      print(HELP);
      return 0;
    }

    // PERMLY_CLI_INTERACTIVE=1 lets tests drive the prompts through a pipe.
    const interactive = process.stdin.isTTY === true || process.env.PERMLY_CLI_INTERACTIVE === "1";
    if (interactive) prompter = new Prompter();

    switch (parsed.command) {
      case "init":
        await init(flags, prompter, readVersion());
        return 0;
      case "migrate":
        await migrate(flags, prompter);
        return 0;
      case undefined:
        throw new UsageError("Missing command. Use `permly init` or `permly migrate`.");
      default:
        throw new UsageError(`Unknown command "${parsed.command}". Use init or migrate.`);
    }
  } catch (error) {
    const message = scrub(error instanceof Error ? error.message : String(error));
    if (error instanceof CancelledError) {
      process.stderr.write(`${message}\n`);
      return 1;
    }
    printError(message);
    if (error instanceof UsageError) {
      process.stderr.write(`Run ${out.cyan("npx permly --help")} for usage.\n`);
      return 2;
    }
    return 1;
  } finally {
    prompter?.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Only reached if printing itself failed.
    console.error(error);
    process.exitCode = 1;
  },
);
