import { clamavScanner, type ClamdConnect } from "./clamav.ts";
import type { VirusScanner } from "./scanner.ts";

/**
 * Chooses the virus scanner from the environment (owner decision 10, ADR 0033).
 *
 * - `XOS_CLAMAV_HOST` set: ClamAV (clamd over TCP, INSTREAM) at that host and `XOS_CLAMAV_PORT`
 *   (default 3310). This is the production scanner: self-hosted `clamav/clamav`, pinned in ADR 0001.
 * - No host, local development: a pass-through that marks every file clean and logs a warning on
 *   every file it lets through, so a developer can use uploads without running clamd. Local means
 *   `SUPABASE_URL` names a loopback or Docker-internal host and `XOS_ENV` is not `production`.
 * - No host anywhere else: no scanner. The worker must not claim scans, so files stay quarantined
 *   (Scanning) and attempts are not used up while the scanner is missing (ADR 0026: fail closed).
 */
export const CLAMAV_DEFAULT_PORT = 3310;

export type ScannerEnv = (name: string) => string | undefined;

export type ScannerChoice =
  | { readonly kind: "clamav"; readonly host: string; readonly port: number }
  | { readonly kind: "pass-through"; readonly reason: string }
  | { readonly kind: "none"; readonly reason: string };

/** Hosts a local Supabase stack or a developer's machine uses; never a production deployment's. */
const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "kong",
  "host.docker.internal",
]);

function present(env: ScannerEnv, name: string): string | undefined {
  const value = env(name)?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** True only for a local development stack: a loopback or Docker-internal SUPABASE_URL. */
export function isLocalDevelopment(env: ScannerEnv): boolean {
  if (present(env, "XOS_ENV")?.toLowerCase() === "production") return false;
  const url = present(env, "SUPABASE_URL");
  if (url === undefined) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return LOCAL_HOSTS.has(host) || host.endsWith(".localhost");
}

/** Reads the scanner configuration. Throws on a port that is not a TCP port number. */
export function scannerChoice(env: ScannerEnv): ScannerChoice {
  const host = present(env, "XOS_CLAMAV_HOST");
  if (host !== undefined) {
    const rawPort = present(env, "XOS_CLAMAV_PORT");
    const port = rawPort === undefined ? CLAMAV_DEFAULT_PORT : Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`XOS_CLAMAV_PORT must be a TCP port number, not ${rawPort ?? ""}.`);
    }
    return { kind: "clamav", host, port };
  }
  if (isLocalDevelopment(env)) {
    return {
      kind: "pass-through",
      reason:
        "XOS_CLAMAV_HOST is not set on a local stack: uploads are marked clean without a virus scan.",
    };
  }
  return {
    kind: "none",
    reason: "XOS_CLAMAV_HOST is not set: uploads stay quarantined until a scanner is configured.",
  };
}

/**
 * Development only: lets every file through as clean and warns on each one. `selectVirusScanner`
 * returns it only for a local stack; nothing else should construct it.
 */
export function passThroughScanner(warn: (message: string) => void): VirusScanner {
  return {
    async scan(bytes) {
      warn(
        `UPLOAD SCAN PASS-THROUGH (local development only): ${bytes.length} bytes marked clean ` +
          "without a virus scan. Set XOS_CLAMAV_HOST to scan with ClamAV.",
      );
      return { clean: true };
    },
  };
}

export interface SelectedScanner {
  readonly choice: ScannerChoice;
  /** Null when no scanner is configured outside local development: do not claim scans. */
  readonly scanner: VirusScanner | null;
}

/** The scanner for this environment, with the choice that produced it for logs and responses. */
export function selectVirusScanner(options: {
  readonly env: ScannerEnv;
  /** Opens a TCP connection to clamd; the runtime supplies it (Deno.connect, node:net). */
  readonly connect: (host: string, port: number) => ReturnType<ClamdConnect>;
  readonly warn: (message: string) => void;
}): SelectedScanner {
  const choice = scannerChoice(options.env);
  switch (choice.kind) {
    case "clamav":
      return {
        choice,
        scanner: clamavScanner({ connect: () => options.connect(choice.host, choice.port) }),
      };
    case "pass-through":
      options.warn(choice.reason);
      return { choice, scanner: passThroughScanner(options.warn) };
    case "none":
      return { choice, scanner: null };
  }
}
