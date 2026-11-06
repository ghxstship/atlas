import { createClient } from "@supabase/supabase-js";
import { createOfferingReader, type OfferingClient } from "@xos/i18n/offering";
import { env } from "@/lib/env";

/** Where XOS is offered now (ADR 0156), read by a signed-out client and kept for a minute in production. */
export const currentOffering = createOfferingReader(() => {
  const config = env();
  return createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }) as unknown as OfferingClient;
}, process.env.NODE_ENV === "production");
