"use server";

import { submitPublicForm } from "@xos/data/form-links";
import { cookies, headers } from "next/headers";
import { observability } from "@/lib/observability";
import { FORM_GRANT_COOKIE, publicDb, visitorAddress } from "@/lib/outside/public";

/**
 * Answers a public form through a client with no session (B2, ADR 0141), so no account is offered or used. The
 * response carries the respondent's name and email and the answers; the database applies every limit.
 */
export async function submitPublicFormAction(
  token: string,
  input: {
    readonly name: string;
    readonly email: string;
    readonly answers: Readonly<Record<string, unknown>>;
    readonly website: string;
  },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const grant = (await cookies()).get(FORM_GRANT_COOKIE)?.value ?? "";
  const sent = await submitPublicForm(publicDb(), {
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
