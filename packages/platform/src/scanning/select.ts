import { clamavScanner, type ClamdConnect } from "./clamav.ts";
import type { VirusScanner } from "./scanner.ts";

/**
 * Chooses the virus scanner from the environment (owner decision 10, ADR 0034).
 *
 * - `XOS_CLAMAV_HOST` set: ClamAV (clamd over TCP, INSTREAM) at that host and `XOS_CLAMAV_PORT`
 *   (default 3310). This is the production scanner: self-hosted `clamav/clamav`, pinned in ADR 0001.
 *   With `XOS_CLAMAV_TLS_CA`, `XOS_CLAMAV_TLS_CERT` and `XOS_CLAMAV_TLS_KEY` (PEM, all three or none)
 *   the connection is mutual TLS to a TLS terminator in front of clamd, which has no authentication of
 *   its own: hosted Edge Functions cannot join a private network (infra/scanning/fly).
 * - No host, local development: a pass-through that marks every file clean and logs a warning on
 *   every file it lets through, so a developer can use uploads without running clamd. Local means
 *   `SUPABASE_URL` names a loopback or Docker-internal host and `XOS_ENVIRONMENT` is not `production`.
 * - No host anywhere else: no scanner. The worker must not claim scans, so files stay quarantined
 *   (Scanning) and attempts are not used up while the scanner is missing (ADR 0026: fail closed).
 */
export const CLAMAV_DEFAULT_PORT = 3310;

export type ScannerEnv = (name: string) => string | undefined;

/** Mutual TLS to clamd's TLS terminator: the CA that signed its certificate, and this client's. */
export interface ClamdTls {
  readonly caCert: string;
  readonly cert: string;
  readonly key: string;
}

export type ScannerChoice =
  | {
      readonly kind: "clamav";
      readonly host: string;
      readonly port: number;
      /** Whether the connection is mutual TLS; the key material never enters the choice. */
      readonly tls?: true;
    }
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
  if (present(env, "XOS_ENVIRONMENT")?.toLowerCase() === "production") return false;
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

const TLS_VARIABLES = ["XOS_CLAMAV_TLS_CA", "XOS_CLAMAV_TLS_CERT", "XOS_CLAMAV_TLS_KEY"] as const;

/**
 * The mutual TLS material for clamd, or null when none is set. A secret set from one line carries its
 * newlines as `\n`, so those are turned back into line breaks. Throws when only some are set.
 */
export function clamdTls(env: ScannerEnv): ClamdTls | null {
  const [caCert, cert, key] = TLS_VARIABLES.map((name) =>
    present(env, name)?.replace(/\\n/g, "\n"),
  );
  if (caCert === undefined && cert === undefined && key === undefined) return null;
  if (caCert === undefined || cert === undefined || key === undefined) {
    throw new Error(
      `Set all of ${TLS_VARIABLES.join(", ")} for mutual TLS to clamd, or none of them.`,
    );
  }
  return { caCert, cert, key };
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
    return clamdTls(env) === null
      ? { kind: "clamav", host, port }
      : { kind: "clamav", host, port, tls: true };
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
  /**
   * Opens a connection to clamd; the runtime supplies it (Deno.connect or Deno.connectTls, node:net).
   * `tls` is the mutual TLS material when it is configured.
   */
  readonly connect: (host: string, port: number, tls: ClamdTls | null) => ReturnType<ClamdConnect>;
  readonly warn: (message: string) => void;
}): SelectedScanner {
  const choice = scannerChoice(options.env);
  switch (choice.kind) {
    case "clamav": {
      const tls = clamdTls(options.env);
      return {
        choice,
        scanner: clamavScanner({ connect: () => options.connect(choice.host, choice.port, tls) }),
      };
    }
    case "pass-through":
      options.warn(choice.reason);
      return { choice, scanner: passThroughScanner(options.warn) };
    case "none":
      return { choice, scanner: null };
  }
}
