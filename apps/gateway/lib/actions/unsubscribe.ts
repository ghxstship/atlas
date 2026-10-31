"use server";

import { z } from "zod";
import { PARAM_TYPES } from "@xos/ia";
import { createAnonSupabase } from "@/lib/supabase/server";

export interface UnsubscribeResult {
  readonly done?: boolean;
  /** The org that sent the email; absent for an unknown token, which answers the same way. */
  readonly orgName?: string | null;
  readonly failed?: boolean;
}

/**
 * The guest pressed Stop emails (B8, 2975): a POST, so the read-write call api_public.unsubscribe_guest_email accepts
 * suppresses the address for the sending org. An unknown token answers like a known one.
 */
export async function unsubscribeGuestAction(
  _: UnsubscribeResult,
  form: FormData,
): Promise<UnsubscribeResult> {
  const token = z.string().regex(PARAM_TYPES.token).safeParse(form.get("token"));
  if (!token.success) return { done: true, orgName: null };
  const { data, error } = await createAnonSupabase().rpc("unsubscribe_guest_email", {
    p_token: token.data,
  });
  if (error) return { failed: true };
  return { done: true, orgName: typeof data === "string" ? data : null };
}
