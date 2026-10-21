"use server";

import type { Route } from "next";
import { redirect } from "next/navigation";
import { safeNext } from "@/lib/auth/redirect";
import { createServerSupabase } from "@/lib/supabase/server";

/** Ends this device's session and opens sign-in, returning to `next` afterwards (A77, org session lifetime). */
export async function signInAgainAction(form: FormData): Promise<void> {
  const next = safeNext(form.get("next"));
  const db = await createServerSupabase();
  const { error } = await db.auth.signOut({ scope: "local" });
  if (error && (error.status ?? 500) >= 500) throw error;
  redirect(`/auth/sign-in?signedOut=1&next=${encodeURIComponent(next)}` as Route);
}
