import { createClient } from "@supabase/supabase-js";
import { createOfferingReader, offeringFetch, type OfferingClient } from "@xos/i18n/offering";
import { env } from "@/lib/env";

/**
 * Where XOS is offered now (ADR 0160), read by a signed-out client and kept for a minute in production. CI's production
 * builds set E2E_OFFERING_FRESH=1 to read it every time, so a journey that opens a territory proves the read works.
 */
export const currentOffering = createOfferingReader(
  () => {
    const config = env();
    return createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: offeringFetch },
    }) as unknown as OfferingClient;
  },
  process.env.NODE_ENV === "production" && process.env["E2E_OFFERING_FRESH"] !== "1",
);
