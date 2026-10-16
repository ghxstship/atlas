/**
 * Aurora in Compass (A25, Section 4.7): the shared conversation store over the public API, called with the
 * person's own session token, so the assistant never sees or does more than they can. The client holds no
 * model provider code and no secret.
 */
import { createAuroraClient, type AuroraClient } from "@xos/ai/client";
import { AuroraConversation } from "@xos/ai/conversation";
import type { SupabaseClient } from "@supabase/supabase-js";

/** The API prefix Atlas serves the public API under. */
export function auroraBaseUrl(atlasUrl: string): string {
  return `${atlasUrl.replace(/\/+$/, "")}/api/v1`;
}

export function compassAuroraClient(
  atlasUrl: string,
  client: Pick<SupabaseClient, "auth">,
  fetchImpl?: typeof fetch,
): AuroraClient {
  return createAuroraClient({
    baseUrl: auroraBaseUrl(atlasUrl),
    headers: async (): Promise<Record<string, string>> => {
      const token = (await client.auth.getSession()).data.session?.access_token;
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

export function compassConversation(
  atlasUrl: string,
  client: Pick<SupabaseClient, "auth">,
): AuroraConversation {
  return new AuroraConversation(compassAuroraClient(atlasUrl, client));
}
