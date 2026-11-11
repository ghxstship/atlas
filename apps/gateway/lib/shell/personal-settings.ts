import type { XosClient } from "@xos/data/gateway";
import { resolveSettings, type ResolvedSetting } from "@xos/data/settings";
import { cache } from "react";
import { NO_ORG } from "@/lib/settings";
import { getSignedInSession } from "./context";

/**
 * The signed-in person's own settings, resolved once per request with no org, so only their personal values and
 * the platform defaults come back (Section 4.5.6, A65-001). The shell and locale negotiation share the read.
 */
export const getPersonalSettings = cache(async (db: XosClient) =>
  resolveSettings(db, { orgId: NO_ORG }),
);

/** The person's own locale.language, saved on any device or shell; null when they kept the platform default. */
export function ownLanguageOf(settings: ReadonlyMap<string, ResolvedSetting>): string | null {
  const setting = settings.get("locale.language");
  return setting?.source === "Personal" && typeof setting.value === "string" ? setting.value : null;
}

/**
 * The signed-in person's own locale.language, or null for a visitor or a person who chose none. It reads the session
 * without getGatewayContext, which sends a person holding an unpassed second factor to /auth/mfa: locale negotiation
 * runs for that page too, and the redirect looped there.
 */
export async function ownLanguage(): Promise<string | null> {
  const { db, user } = await getSignedInSession();
  if (!user) return null;
  const settings = await getPersonalSettings(db);
  return settings.ok ? ownLanguageOf(settings.data) : null;
}
