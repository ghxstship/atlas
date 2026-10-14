/**
 * Structured JSON logging (Section 5: structured JSON logs). One line per event on stdout, which
 * Vercel and Supabase collect and forward through their log drains. Every field passes through
 * `redact` before it is serialized, so personal data never reaches a log store.
 */

import { redact, redactString, type RedactOptions } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Fields every record carries. Names follow OpenTelemetry semantic conventions where one exists. */
export interface ServiceIdentity {
  /** `atlas`, `gateway`, `api`, `edge.<function>`, `synthetics`. */
  readonly service: string;
  /** `production`, `preview`, `staging`, `development`, `test`. */
  readonly environment: string;
  /** Git SHA or release tag of the running build. */
  readonly release?: string;
  /** Hosting region, for example `iad1`. */
  readonly region?: string;
}

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger whose records also carry `fields` (request id, trace id, org id). */
  child(fields: LogFields): Logger;
  readonly identity: ServiceIdentity;
}

export interface LoggerOptions extends ServiceIdentity {
  readonly level?: LogLevel;
  /** Receives one serialized JSON line per record. Defaults to stdout (or stderr for warn and error). */
  readonly sink?: (line: string, level: LogLevel) => void;
  readonly now?: () => Date;
  readonly redaction?: RedactOptions;
}

/** Keys the logger owns; caller fields with these names are nested under `fields` instead. */
const RESERVED = new Set([
  "timestamp",
  "level",
  "message",
  "service",
  "environment",
  "release",
  "region",
]);

function defaultSink(line: string, level: LogLevel): void {
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_RANK[options.level ?? "info"];
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());
  const identity: ServiceIdentity = {
    service: options.service,
    environment: options.environment,
    ...(options.release ? { release: options.release } : {}),
    ...(options.region ? { region: options.region } : {}),
  };

  const build = (bound: LogFields): Logger => {
    const write = (level: LogLevel, message: string, fields?: LogFields) => {
      if (LEVEL_RANK[level] < threshold) return;
      const merged = redact({ ...bound, ...fields }, options.redaction) as Record<string, unknown>;
      const record: Record<string, unknown> = {
        timestamp: now().toISOString(),
        level,
        message: redactString(message, 1024),
        ...identity,
      };
      const nested: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(merged)) {
        if (RESERVED.has(key)) nested[key] = value;
        else record[key] = value;
      }
      if (Object.keys(nested).length > 0) record["fields"] = nested;
      sink(safeStringify(record), level);
    };
    return {
      identity,
      debug: (m, f) => write("debug", m, f),
      info: (m, f) => write("info", m, f),
      warn: (m, f) => write("warn", m, f),
      error: (m, f) => write("error", m, f),
      child: (fields) => build({ ...bound, ...fields }),
    };
  };

  return build({});
}

/** JSON.stringify that never throws: values it cannot encode are described instead. */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({
      level: "error",
      message: "log record could not be serialized",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Reads the service identity from the environment variables Vercel and Supabase set. */
export function identityFromEnv(
  service: string,
  env: Readonly<Record<string, string | undefined>>,
): ServiceIdentity {
  const environment =
    env["XOS_ENVIRONMENT"] ?? env["VERCEL_ENV"] ?? env["NODE_ENV"] ?? "development";
  const release = env["XOS_RELEASE"] ?? env["VERCEL_GIT_COMMIT_SHA"];
  const region = env["VERCEL_REGION"] ?? env["SB_REGION"];
  return {
    service,
    environment,
    ...(release ? { release } : {}),
    ...(region ? { region } : {}),
  };
}
