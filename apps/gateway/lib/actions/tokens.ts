"use server";

import {
  previewAdvance,
  previewTokenDocument,
  previewTokenQuote,
  signTokenDocument,
  submitAdvance,
  type AdvancePacket,
  type TokenDocument,
  type TokenQuote,
} from "@xos/data/gateway";
import { z } from "zod";
import { outcomeFor } from "@/lib/action-result";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Token flows without an account (Section 4.4.6): advance forms (A10 api_public.preview_advance
 * and submit_advance) and signing links (A28b api_public.token_document and token_sign_document).
 * The access code travels only in the form body, never in a URL. Refusals come back as their rule
 * code so the page can say exactly what to do (`gateway.tokens.refusals.<rule>`).
 */

const token = z.string().min(16).max(256);
const code = z.string().trim().min(4).max(32);

export type TokenOutcome<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly refusal?: string; readonly outcome?: string };

export async function openAdvanceAction(input: {
  token: string;
  accessCode: string;
}): Promise<TokenOutcome<AdvancePacket>> {
  const t = token.safeParse(input.token);
  const c = code.safeParse(input.accessCode);
  if (!t.success || !c.success) return { ok: false, refusal: "advance_access_code" };
  const result = await previewAdvance(await createServerSupabase(), {
    token: t.data,
    accessCode: c.data,
  });
  if (!result.ok) return { ok: false, outcome: outcomeFor(result.error) };
  return result.data.refused
    ? { ok: false, refusal: result.data.reason }
    : { ok: true, data: result.data };
}

export async function answerAdvanceTokenAction(input: {
  token: string;
  accessCode: string;
  sectionId: string;
  body: string;
}): Promise<TokenOutcome<{ submittedAt: string }>> {
  const parsed = z
    .object({
      token,
      accessCode: code,
      sectionId: z.uuid(),
      body: z.string().trim().min(1).max(20000),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, refusal: "advance_answer_length" };
  const result = await submitAdvance(await createServerSupabase(), parsed.data);
  if (!result.ok) return { ok: false, outcome: outcomeFor(result.error) };
  return result.data.refused
    ? { ok: false, refusal: result.data.reason }
    : { ok: true, data: { submittedAt: result.data.submittedAt } };
}

export async function openDocumentAction(input: {
  token: string;
  accessCode: string;
}): Promise<TokenOutcome<TokenDocument>> {
  const t = token.safeParse(input.token);
  const c = code.safeParse(input.accessCode);
  if (!t.success || !c.success) return { ok: false, refusal: "document_access_code" };
  const result = await previewTokenDocument(await createServerSupabase(), {
    token: t.data,
    accessCode: c.data,
  });
  if (!result.ok) return { ok: false, outcome: outcomeFor(result.error) };
  return result.data.refused
    ? { ok: false, refusal: result.data.reason }
    : { ok: true, data: result.data };
}

/** A Quote document's lines, total and terms, after the access code (S4.4-12). */
export async function openQuoteAction(input: {
  token: string;
  accessCode: string;
}): Promise<TokenOutcome<TokenQuote>> {
  const t = token.safeParse(input.token);
  const c = code.safeParse(input.accessCode);
  if (!t.success || !c.success) return { ok: false, refusal: "document_access_code" };
  const result = await previewTokenQuote(await createServerSupabase(), {
    token: t.data,
    accessCode: c.data,
  });
  if (!result.ok) return { ok: false, outcome: outcomeFor(result.error) };
  return result.data.refused
    ? { ok: false, refusal: result.data.reason }
    : { ok: true, data: result.data };
}

const QUOTE_SIGN_REFUSALS: readonly string[] = [
  "quote_expired",
  "quote_not_sent",
  "quote_client_engagement",
];
const isQuoteSignRefusal = (rule: string) => QUOTE_SIGN_REFUSALS.includes(rule);

export async function signDocumentTokenAction(input: {
  token: string;
  accessCode: string;
  signerName: string;
}): Promise<TokenOutcome<{ signedAt: string }>> {
  const parsed = z
    .object({ token, accessCode: code, signerName: z.string().trim().min(2).max(200) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, refusal: "document_signer_name" };
  const result = await signTokenDocument(await createServerSupabase(), parsed.data);
  // Inside token_sign_document a quote's refusals raise rather than return (3024); they read as the others
  // do. Any other raised rule, such as a lifecycle conflict from two signers at once, has its copy under
  // the outcomes and goes through outcomeFor.
  if (!result.ok && result.error.kind === "refusal" && isQuoteSignRefusal(result.error.rule)) {
    return { ok: false, refusal: result.error.rule };
  }
  if (!result.ok) return { ok: false, outcome: outcomeFor(result.error) };
  return result.data.refused
    ? { ok: false, refusal: result.data.reason }
    : { ok: true, data: { signedAt: result.data.signedAt } };
}
