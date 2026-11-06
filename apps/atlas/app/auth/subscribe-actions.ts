"use server";

import { subscribeExternalAccount } from "@xos/data/identity";
import { recordLegalAcceptances } from "@xos/data/settings";
import { isCountryCode } from "@xos/i18n/formats";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { clientIp, signupAcceptances } from "@/lib/auth/legal";
import { notOfferedValues } from "@/lib/auth/territory";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Journey 60: the Account Owner of an external account starts Atlas with that company
 * (app.subscribe_external_account). The same organization becomes a subscribed org, so its
 * profile, ratings and history carry over; the Owner accepts the signup documents as on create.
 */
export interface SubscribeState {
  readonly error?: "accept" | "country" | "refused" | "territory_not_offered" | "unexpected";
  /** Values for the refusal's sentence. */
  readonly errorValues?: Readonly<Record<string, string>>;
  /** The country chosen, kept after a failed submit. */
  readonly country?: string;
}

export async function subscribeAccountAction(
  _: SubscribeState,
  form: FormData,
): Promise<SubscribeState> {
  const chosen = form.get("country");
  const country = typeof chosen === "string" ? chosen : "";
  if (!isCountryCode(country)) {
    return { error: form.get("accept") === "on" ? "country" : "accept" };
  }
  const parsed = z
    .object({ accountId: z.uuid(), slug: z.string().min(1), accept: z.literal("on") })
    .safeParse({
      accountId: form.get("accountId"),
      slug: form.get("slug"),
      accept: form.get("accept"),
    });
  if (!parsed.success) {
    return { error: form.get("accept") === "on" ? "unexpected" : "accept", country };
  }
  const db = await createServerSupabase();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) redirect("/auth/sign-in?next=%2Fauth%2Forganization");
  const subscribed = await subscribeExternalAccount(db, parsed.data.accountId, country);
  if (!subscribed.ok) {
    if (subscribed.error.kind === "refusal" && subscribed.error.rule === "territory_not_offered") {
      return {
        error: "territory_not_offered",
        errorValues: await notOfferedValues(country),
        country,
      };
    }
    return { error: subscribed.error.kind === "refusal" ? "refused" : "unexpected", country };
  }
  const recorded = await recordLegalAcceptances(db, {
    orgId: subscribed.data.orgId,
    documents: signupAcceptances(),
    clientIp: clientIp(await headers()),
  });
  if (!recorded.ok) {
    throw new Error(`Legal acceptance was not recorded: ${JSON.stringify(recorded.error)}`);
  }
  redirect(`/${parsed.data.slug}/home`);
}
