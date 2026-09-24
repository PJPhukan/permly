import { defineConfig } from "tsup";

const shared = {
  sourcemap: false,
  splitting: false,
  treeshake: true,
  target: "node18",
  // `npm run build` empties dist first; the two builds below run in parallel.
  clean: false,
} as const;

export default defineConfig([
  {
    ...shared,
    entry: {
      index: "src/index.ts",
      memory: "src/adapters/memory.ts",
      mysql: "src/adapters/mysql.ts",
      postgres: "src/adapters/postgres.ts",
      mongodb: "src/adapters/mongodb.ts",
      express: "src/express/index.ts",
    },
    format: ["cjs", "esm"],
    dts: true,
  },
  {
    // The `permly` command: its own bundle, never imported by the library entries.
    ...shared,
    entry: { cli: "src/cli/index.ts" },
    format: ["esm"],
    dts: false,
  },
]);
