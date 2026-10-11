/**
 * Runs once when the Atlas server boots. Validating the environment here fails fast with a clear
 * message (lib/env.ts) instead of on the first request.
 */
export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] === "nodejs") {
    const { env } = await import("./lib/env");
    env();
  }
}
