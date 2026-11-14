"use server";

import { CONSENT_BANNER_VERSION } from "@xos/data/consent";
import { decideConsent, type ConsentChoice } from "@xos/ui/consent";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { createServerSupabase } from "@/lib/supabase/server";
import { observability } from "@/lib/observability";
import { consentState, secureCookies } from "./consent";
import { atlasConsentAdapter, CONSENT_CATEGORIES } from "./consent-adapter";

/**
 * Saves the visitor's cookie choice from the banner or the Cookie settings page (Section 14.3). The
 * forms are the shared ConsentBanner and ConsentSettings of @xos/ui; the decision is written through
 * Atlas's consent adapter, to the server-side consent log and the consent cookie. A browser sending
 * Global Privacy Control refuses every non-essential category whatever was ticked: the signal is the
 * `Sec-GPC` header, or the `gpc` field the banner posts when only `navigator.globalPrivacyControl`
 * reports it. Plain forms, so the banner works before any script loads.
 */
export async function saveCookieChoice(form: FormData): Promise<void> {
  const posted = form.get("choice");
  const choice: ConsentChoice = posted === "all" || posted === "save" ? posted : "none";
  const [state, store, db] = await Promise.all([consentState(), cookies(), createServerSupabase()]);
  const decision = decideConsent({
    choice,
    categories: CONSENT_CATEGORIES,
    selected: CONSENT_CATEGORIES.filter((name) => form.get(name) === "on"),
    gpc: state.gpc || form.get("gpc") === "1",
    policyVersion: CONSENT_BANNER_VERSION,
  });
  const adapter = atlasConsentAdapter({
    db,
    cookies: store,
    secure: secureCookies(),
    onUnrecorded: (error) =>
      observability.logger.error("cookie consent was not recorded", { error }),
  });
  await adapter.write(decision);
  revalidatePath("/", "layout");
}
