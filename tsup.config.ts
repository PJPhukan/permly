import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    memory: "src/adapters/memory.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  splitting: false,
  treeshake: true,
  target: "node18",
});
