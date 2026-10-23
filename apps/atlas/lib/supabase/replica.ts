import type { XosClient } from "@xos/data";
import { createReplicaCallerClient } from "@xos/data/read-replica";
import { env } from "@/lib/env";

/**
 * The signed-in person's client on the read replica (XOS_READ_REPLICA_URL, Section 5.1), or null when no
 * replica is configured or there is no session. It carries the same anon key and access token as `db`,
 * so row level security on the replica decides exactly as on the primary. Reads only: callers pass it to
 * `preferReplica` from `@xos/data/read-replica`, which falls back to the primary.
 */
export async function replicaClientFor(db: XosClient): Promise<XosClient | null> {
  const config = env();
  if (config.XOS_READ_REPLICA_URL === undefined) return null;
  const { data } = await db.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) return null;
  return createReplicaCallerClient(
    { XOS_READ_REPLICA_URL: config.XOS_READ_REPLICA_URL },
    { anonKey: config.SUPABASE_ANON_KEY, accessToken },
  );
}
