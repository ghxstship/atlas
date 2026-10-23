import { createCallerClient, type CallerClientOptions, type XosClient } from "./client.ts";

/**
 * Read replicas serve reports and exports (Section 5.1, A65-032).
 *
 * `XOS_READ_REPLICA_URL` names the Data API origin of a Supabase read replica
 * (`https://<ref>-rr-<region>-<id>.supabase.co`, Project Settings, Infrastructure). When it is set, the
 * heavy reads of the report worker and the full org export go to the replica; when it is not, nothing
 * changes. A replica uses the project's JWT keys, so the same keys and the same row level security apply
 * there as on the primary.
 *
 * A replica can lag the primary by a moment and accepts reads only (GET), so every replica read falls back
 * to the primary: when the replica errors, when it answers something the caller cannot use (a row it has
 * not received yet), or when it refuses. Writes never go to the replica.
 */

export const READ_REPLICA_ENV = "XOS_READ_REPLICA_URL";

/** The replica's origin from the environment, or null when it is unset, blank or not an http(s) URL. */
export function readReplicaUrl(
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void = () => {},
): string | null {
  const raw = env[READ_REPLICA_ENV]?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError(url.protocol);
    return url.origin;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    warn(`${READ_REPLICA_ENV} is not an http(s) URL; reads stay on the primary.`);
    return null;
  }
}

export interface ReplicaReadOptions<T> {
  /** Names the read in the fallback report, for example `report rows`. */
  readonly label: string;
  /** False when the replica's answer cannot be used, so the primary is asked instead. */
  readonly usable?: ((result: T) => boolean) | undefined;
  /** Called once for every read the primary answers instead of the replica. */
  readonly onFallback?: ((label: string, reason: unknown) => void) | undefined;
}

/**
 * Runs `read` against the replica when there is one, and against the primary when there is none, when
 * the replica throws, or when its answer is not `usable`.
 */
export async function preferReplica<C, T>(
  primary: C,
  replica: C | null | undefined,
  read: (client: C, onReplica: boolean) => Promise<T>,
  options: ReplicaReadOptions<T>,
): Promise<T> {
  if (replica === null || replica === undefined) return read(primary, false);
  try {
    const result = await read(replica, true);
    if (options.usable === undefined || options.usable(result)) return result;
    options.onFallback?.(options.label, "unusable");
  } catch (error) {
    options.onFallback?.(options.label, error);
  }
  return read(primary, false);
}

/**
 * A client that acts as the caller against the replica (the same anon key and the caller's token), or
 * null when no replica is configured.
 */
export function createReplicaCallerClient(
  env: Readonly<Record<string, string | undefined>>,
  options: Omit<CallerClientOptions, "url">,
  warn?: (message: string) => void,
): XosClient | null {
  const url = readReplicaUrl(env, warn);
  return url === null ? null : createCallerClient({ ...options, url });
}
