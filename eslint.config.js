import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default defineConfig(
  { ignores: ["dist", "node_modules", "coverage"] },
  js.configs.recommended,
  tseslint.configs.strict,
  { languageOptions: { globals: globals.node } },
  prettier,
);
