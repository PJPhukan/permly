import { execFileSync } from "node:child_process";

// The CLI tests spawn the real built `dist/cli.js`, so build once before any test runs.
export default function setup() {
  execFileSync(process.execPath, ["node_modules/tsup/dist/cli-default.js", "--silent"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
}
