"use server";

import { claimTokenSubmissions } from "@xos/data/gateway";
import { outcomeFor } from "@/lib/action-result";
import { createServerSupabase } from "@/lib/supabase/server";

export interface ClaimState {
  readonly outcome?: string;
  readonly claimed?: { readonly advance: number; readonly documents: number };
}

/** Links token submissions sent to the signed-in person's verified email (Section 4.4.6). */
export async function claimAction(): Promise<ClaimState> {
  const result = await claimTokenSubmissions(await createServerSupabase());
  return result.ok ? { claimed: result.data } : { outcome: outcomeFor(result.error) };
}
