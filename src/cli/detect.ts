import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export interface Project {
  cwd: string;
  hasPackageJson: boolean;
  typescript: boolean;
  /** package.json has "type": "module". */
  esm: boolean;
  hasSrcDir: boolean;
}

export function detectProject(cwd: string): Project {
  const packageJsonPath = join(cwd, "package.json");
  let type: unknown;
  if (existsSync(packageJsonPath)) {
    try {
      type = (JSON.parse(readFileSync(packageJsonPath, "utf8")) as { type?: unknown }).type;
    } catch {
      // A broken package.json is the user's to fix; treat it as CommonJS.
    }
  }
  return {
    cwd,
    hasPackageJson: existsSync(packageJsonPath),
    typescript: existsSync(join(cwd, "tsconfig.json")),
    esm: type === "module",
    hasSrcDir: existsSync(join(cwd, "src")),
  };
}

/** Resolves a package the way the user's own code would, from their project folder. */
export function requireFromProject(cwd: string): NodeJS.Require {
  // The file doesn't have to exist; it only anchors node_modules lookup at `cwd`.
  return createRequire(join(cwd, "__permly_cli__.js"));
}

export function isInstalled(cwd: string, name: string): boolean {
  try {
    requireFromProject(cwd).resolve(name);
    return true;
  } catch {
    return false;
  }
}
