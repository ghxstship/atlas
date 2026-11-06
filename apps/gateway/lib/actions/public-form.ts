"use server";

import { submitPublicForm } from "@xos/data/form-links";
import { cookies, headers } from "next/headers";
import { observability } from "@/lib/observability";
import { FORM_GRANT_COOKIE, visitorAddress } from "@/lib/outside/public";
import { getGatewayContext } from "@/lib/shell/context";

/**
 * Answers a public form as the signed-in person (B2, ADR 0141; owner ruling 2026-11-06 on invariant 8): the database
 * takes their name and email from their account and applies every limit.
 */
export async function submitPublicFormAction(
  token: string,
  input: {
    readonly answers: Readonly<Record<string, unknown>>;
    readonly website: string;
  },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const grant = (await cookies()).get(FORM_GRANT_COOKIE)?.value ?? "";
  const ctx = await getGatewayContext();
  if (ctx === null) return { ok: false, reason: "form_link_sign_in" };
  const sent = await submitPublicForm(ctx.db, {
    token,
    grant,
    ...input,
    clientAddress: visitorAddress(await headers()),
  });
  if (!sent.ok) {
    observability.logger.error("public form submit failed", {
      route: "/forms/[token]",
      error: sent.error,
    });
    return { ok: false, reason: "unexpected" };
  }
  return sent.data.refused ? { ok: false, reason: sent.data.reason } : { ok: true };
}
