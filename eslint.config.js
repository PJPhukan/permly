import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default defineConfig(
  { ignores: ["dist", "node_modules", "coverage", "examples/*/node_modules", "examples/*/dist"] },
  js.configs.recommended,
  tseslint.configs.strict,
  { languageOptions: { globals: globals.node } },
  {
    rules: {
      // `_`-prefixed variables and arguments are intentionally unused (e.g. Express's 4-argument error handler).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["examples/express-cjs/**/*.js"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // Examples favour short, readable code; `!` is used where a guard already guarantees the value.
    files: ["examples/**/*.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
  prettier,
);
