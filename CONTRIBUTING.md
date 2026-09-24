# Contributing to permly

Thanks for helping! Bug reports, docs fixes, tests and new adapters are all welcome. For
anything bigger than a small fix, please open an issue first so we can agree on the approach.

## Setup

You need Node.js 22 (the tools need it; the published package supports Node 18+), npm, and
Docker for the database tests.

```sh
git clone https://github.com/PJPhukan/permly.git
cd permly
npm install
npm run db:up        # MySQL, MariaDB, Postgres 13/17, MongoDB 7/8 in Docker
npm run check        # typecheck, lint, format check, all tests, build
npm run db:down      # when you're done
```

## Everyday commands

| Command                 | What it does                                                                    |
| ----------------------- | ------------------------------------------------------------------------------- |
| `npm test`              | All tests (builds first). Database tests skip, with a message, if a DB is down. |
| `npm run test:ci`       | Same, but an unreachable database **fails** the run (what CI does).             |
| `npm run test:watch`    | Tests in watch mode.                                                            |
| `npm run typecheck`     | TypeScript, no output.                                                          |
| `npm run lint`          | ESLint.                                                                         |
| `npm run format`        | Prettier (write). `format:check` only checks.                                   |
| `npm run build`         | Builds `dist/` with tsup (CommonJS, ES modules, `.d.ts`, CLI).                  |
| `npm run examples:test` | Packs the package and tests the examples and the CLI flow against it.           |
| `npm run check`         | Everything above except `examples:test`.                                        |

Database tests connect to the docker compose databases by default. Point them elsewhere with
`PERMLY_MYSQL_URL`, `PERMLY_MARIADB_URL`, `PERMLY_PG13_URL`, `PERMLY_PG17_URL`,
`PERMLY_MONGO7_URL`, `PERMLY_MONGO7RS_URL`, `PERMLY_MONGO8_URL` and `PERMLY_MONGO8RS_URL`. They
create and drop their own tables (`permly_test_*`, `cli_test_*`, ...). `PERMLY_EXPLAIN=1`
prints the query plans the performance tests check.

Docker ports: MySQL 33061, MariaDB 33062, Postgres 13 54313, Postgres 17 54317 (SSL on, with a
self-signed certificate generated at every start; no key is ever stored in the repo), MongoDB 7
27107 (replica set 27117), MongoDB 8 27108 (replica set 27118). Connect to the replica sets with
`?directConnection=true`.

`npm run examples:test` also runs the new-user CLI flow against MySQL, Postgres and MongoDB
(`EXAMPLES_DATABASE_URL`, `EXAMPLES_POSTGRES_URL`, `EXAMPLES_MONGODB_URL`, defaulting to docker
compose). `PERMLY_CLI_INTERACTIVE=1` makes the CLI prompt even when stdin is a pipe, which the
CLI tests use to type answers.

## Project structure

```text
src/
  index.ts              public exports of "permly"
  core/                 createPermissions, user/role scopes, validation, cache, errors, types
  adapters/             memory, mysql, postgres, mongodb (+ schema/setup and lock helpers)
  express/              "permly/express" middleware
  cli/                  "npx permly" (init, migrate): its own bundle, never loaded by the library
test/
  core/                 core behaviour with the memory adapter
  adapters/             adapter-contract.ts (the shared suite) + one file per adapter
  express/              middleware on Express 4 and 5
  cli/                  spawns the built CLI in temp folders
  types/                type-level tests (autocomplete, typos, Express typings)
  readme.test.ts        runs / type-checks every example in README.md
examples/               express-cjs, express-esm, express-ts
scripts/                examples-test, cli-flow, node-compat, gen-type-bench
```

## Rules of the codebase

- **No runtime dependencies.** Database drivers and Express are optional peer dependencies, and
  adapters use structural types instead of importing them.
- Subpath entries (`permly/mysql`, `permly/express`, ...) import only **types** from core. The
  exception is the error classes, which are safe to duplicate because they're recognised by a
  `Symbol.for("permly.error")` brand, not `instanceof`.
- All SQL uses bound parameters. Table names come only from the validated prefix (and schema).
- Keep it simple and readable: small files, clear names, comments that explain _why_.
- Size budget: core JS (`dist/index.js`) under 30 KB, unminified. Type declarations don't count.
- Every README example is tested (`test/readme.test.ts`). Mark a block that can't run with
  `<!-- test: skip (reason) -->`, or with `<!-- test: postgres -->` (etc.) if it needs a database.
- TypeScript is pinned to `~5.9`: tsup's declaration build passes `baseUrl`, which TypeScript 6
  rejects. The published `.d.ts` files work with TypeScript 5 and 6.

## Adding an adapter

1. Create `src/adapters/<name>.ts` exporting a factory that returns a `PermissionAdapter` (see
   `src/core/types.ts` for the contract: idempotent creates, cascading deletes, `set*` replacing
   a list, unknown names ignored).
2. Keep the schema in one place (like `mysql-schema.ts`) so the CLI can reuse it.
3. Make `setUserRoles` / `setRolePermissions` safe under concurrency (see how the other adapters
   lock), and remove old entries before adding new ones so reads fail closed.
4. Add `test/adapters/<name>.test.ts` that runs the shared suite against a real database:

   ```ts
   import { runAdapterContract } from "./adapter-contract";

   runAdapterContract("MyDB", async () => {
     await emptyAllTables();
     return myAdapter(connection);
   });
   ```

   The suite covers what every adapter must do, including fail-closed reads during syncs. Add
   adapter-specific tests next to it (concurrency, query plans, error messages).

5. Add the entry to `tsup.config.ts`, `package.json` (`exports`, `typesVersions`, optional peer
   dependency), docker-compose and CI, and document it in the README.

## Commits and pull requests

- Plain, descriptive commit messages (e.g. `Fix canOwn when the owner id is a number`).
- One topic per pull request, with tests. The pull request template has the checklist.
- CI must pass: lint, typecheck, build, unit tests on Linux/macOS/Windows, the packed package on
  Node 18/20/22, database tests, and the examples.
- Update `CHANGELOG.md` (under "Unreleased") and the README for anything users will notice.

## Releasing (maintainers)

1. Update the version in `package.json` and `CHANGELOG.md`.
2. Commit, then tag and push: `git tag v0.1.0 && git push origin main v0.1.0`.
3. The Release workflow runs every check and publishes to npm with provenance.
