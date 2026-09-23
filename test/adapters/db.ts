/**
 * Connects to a test database, or returns undefined (with a visible message) so its tests skip.
 * With PERMLY_REQUIRE_DB=1 (for CI) an unreachable database fails the run instead.
 */
export async function connectOrSkip<T>(
  label: string,
  envVar: string,
  connect: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await connect();
  } catch (err) {
    const reason = err instanceof Error ? err.message || err.name : String(err);
    if (process.env.PERMLY_REQUIRE_DB === "1") {
      throw new Error(`${label} is required (PERMLY_REQUIRE_DB=1) but unreachable: ${reason}`, {
        cause: err,
      });
    }
    // Written straight to stderr: vitest drops console output emitted while collecting tests.
    process.stderr.write(
      `\n  ⚠ Skipping ${label} tests: database unreachable (${reason}).\n` +
        `    Start it with "docker compose up -d --wait", or point ${envVar} at your own server.\n` +
        `    Set PERMLY_REQUIRE_DB=1 to fail instead of skip.\n`,
    );
    return undefined;
  }
}
