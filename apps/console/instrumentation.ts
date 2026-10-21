/**
 * Runs once when the console server boots: validates the environment (lib/env.ts), so a missing variable fails
 * fast with a clear message instead of on the first request.
 */
export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] === "nodejs") {
    const { env } = await import("./lib/env");
    env();
  }
}
