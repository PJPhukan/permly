# Contributing

## Setup

```sh
npm install
npm run db:up      # MySQL 8.4 and MariaDB 11 in Docker (ports 33061, 33062)
npm run check      # typecheck, lint, format check, tests, build
npm run db:down
```

## Tests

- `npm test` runs everything. Database tests **skip** (with a message) when their database
  is unreachable.
- `npm run test:ci` sets `PERMLY_REQUIRE_DB=1`, which makes an unreachable database **fail**
  the run instead. Use this in CI.
- Point tests at your own servers with `PERMLY_MYSQL_URL` / `PERMLY_MARIADB_URL`
  (e.g. `mysql://user:pass@host:3306/db`). Tests create and drop tables named `permly_test_*`.
- `PERMLY_EXPLAIN=1` prints the query plan of `getUserAccess` for each database.
- Every adapter runs the shared suite in `test/adapters/adapter-contract.ts`.
- `node scripts/gen-type-bench.mjs` regenerates the 200-permission type test.
- CLI tests spawn the built `dist/cli.js` (the test run builds first) in temp folders.
  `PERMLY_CLI_INTERACTIVE=1` makes the CLI prompt even when stdin is a pipe, so tests can type
  answers.
- Express middleware tests run against both Express 4 and 5 (installed as `express4` /
  `express5` aliases).
- `npm run examples:test` packs the package, installs the tarball into a temp copy of each
  example, builds it if needed, starts it and checks its responses. Set
  `EXAMPLES_DATABASE_URL` to also run each example against MySQL (it creates `perm_*` tables
  there).

## Rules

- **No runtime dependencies.** Database drivers are optional peer dependencies.
- Subpath entries (`permly/mysql`, `permly/express`, …) import only **types** from core.
  The exception is the error classes, which are safe to duplicate because they are
  recognised by a `Symbol.for("permly.error")` brand, not `instanceof`.
- All SQL uses bound parameters. Table names come only from the validated prefix.
- Size budget: core JS (`dist/index.js`) under 30 KB, unminified. Type declarations don't count.

## Why TypeScript is pinned to 5.9

`typescript` is pinned to `~5.9` because tsup's declaration build passes `baseUrl`, which
TypeScript 6 rejects (TS5101). This only affects building permly; the published `.d.ts`
files work with TypeScript 5 and 6. Unpin once tsup supports TypeScript 6.
