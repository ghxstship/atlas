"use server";

import {
  beginAdvanceUpload,
  finishAdvanceUpload,
  inviteAdvanceRosterMember,
  listAdvanceRoster,
  previewAdvance,
  previewTokenDocument,
  requestAdvanceGuest,
  signTokenDocument,
  storeAdvanceUpload,
  submitAdvance,
  submitAdvanceRoster,
  submitAdvanceTyped,
  type AdvancePacket,
  type AdvanceRosterEntry,
  type Result,
  type TokenDocument,
  type TokenRefusal,
} from "@xos/data/gateway";
import { createHash } from "node:crypto";
import { z } from "zod";
import { outcomeFor, refusalOutcome } from "@/lib/action-result";
import type { FormResult } from "@/lib/actions/operations";
import { answerHead, answerHeadOf, answerLines, formFiles } from "@/lib/advance-answer-form";
import { localToInstant } from "@/lib/local-time";
import { createAnonSupabase, createServerSupabase } from "@/lib/supabase/server";

/**
 * Token flows without an account (Section 4.4.6): advance forms (A10 api_public.preview_advance
 * and submit_advance) and signing links (A28b api_public.token_document and token_sign_document).
 * The access code travels only in the form body, never in a URL. Refusals come back as their rule
 * code so the page can say exactly what to do (`gateway.tokens.refusals.<rule>`).
 *
 * R10 (migrations 2730 and 2731): the link answers every kind of section the Advance tab does. The
 * typed forms of components/engagement/advance-forms.tsx post here through the token adapter
 * (lib/token-form.ts), which adds the token and code to the form body; these actions return the
 * FormResult those forms read, a refusal as `refusals.<rule>` under gateway.outcomes. They call the
 * api_public RPCs and the upload with the anonymous client, so a link answer is the link's whoever
 * is signed in, and its allocations are requested by the person who later claims the link.
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

const link = z.object({ token, accessCode: code, sectionId: z.uuid() });

function linkOf(form: FormData) {
  return {
    token: form.get("token"),
    accessCode: form.get("accessCode"),
    sectionId: form.get("sectionId"),
  };
}

/** A data result as the typed forms read it: done, a refusal rule's outcome, or the failure. */
function formResult(result: Result<{ readonly refused: false } | TokenRefusal>): FormResult {
  if (!result.ok) return { outcome: outcomeFor(result.error) };
  return result.data.refused ? { outcome: refusalOutcome(result.data.reason) } : { done: true };
}

/** A Schedule Window, Item Request, Credential Request or Guest List answer through the link. */
export async function answerAdvanceTypedTokenAction(
  _: FormResult,
  form: FormData,
): Promise<FormResult> {
  const l = link.safeParse(linkOf(form));
  const head = answerHead.safeParse(answerHeadOf(form));
  if (!l.success) return { outcome: refusalOutcome("advance_access_code") };
  if (!head.success) return { fieldError: "answer" };
  const lines = answerLines(form, head.data.lines, head.data.timeZone);
  if (!Array.isArray(lines)) return lines;
  return formResult(
    await submitAdvanceTyped(createAnonSupabase(), {
      ...l.data,
      note: head.data.note === "" ? null : head.data.note,
      lines,
    }),
  );
}

/**
 * A File section's answer through the link: for each file a ticket (begin), the upload to the one
 * object the ticket names, and its registration (finish), all on the server; then one answer that
 * attaches the documents.
 */
export async function uploadAdvanceTokenFileAction(
  _: FormResult,
  form: FormData,
): Promise<FormResult> {
  const l = link.safeParse(linkOf(form));
  const note = z
    .string()
    .trim()
    .max(2000)
    .safeParse(form.get("note") ?? "");
  if (!l.success) return { outcome: refusalOutcome("advance_access_code") };
  if (!note.success) return { fieldError: "file" };
  const files = formFiles(form);
  if (!Array.isArray(files)) return files;
  const db = createAnonSupabase();
  const documentIds: string[] = [];
  for (const file of files) {
    const ticket = await beginAdvanceUpload(db, {
      ...l.data,
      fileName: file.name,
      contentType: file.type,
      byteSize: file.size,
    });
    if (!ticket.ok) return { outcome: outcomeFor(ticket.error) };
    if (ticket.data.refused) return { outcome: refusalOutcome(ticket.data.reason) };
    const bytes = Buffer.from(await file.arrayBuffer());
    const stored = await storeAdvanceUpload(db, {
      objectName: ticket.data.objectName,
      body: new Blob([bytes], { type: file.type }),
      contentType: file.type,
    });
    if (!stored.ok) return { outcome: outcomeFor(stored.error) };
    const finished = await finishAdvanceUpload(db, {
      token: l.data.token,
      accessCode: l.data.accessCode,
      ticketId: ticket.data.ticketId,
      title: file.name.slice(0, 200) || "Upload",
      checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    if (!finished.ok) return { outcome: outcomeFor(finished.error) };
    if (finished.data.refused) return { outcome: refusalOutcome(finished.data.reason) };
    documentIds.push(finished.data.documentId);
  }
  return formResult(
    await submitAdvanceTyped(db, {
      ...l.data,
      note: note.data === "" ? null : note.data,
      documentIds,
    }),
  );
}

/** A guest on a Guest List section through the link; the production approves or declines. */
export async function requestTokenGuestAction(_: FormResult, form: FormData): Promise<FormResult> {
  const l = link.safeParse(linkOf(form));
  if (!l.success) return { outcome: refusalOutcome("advance_access_code") };
  const guest = z
    .object({
      guestName: z.string().trim().min(1).max(200),
      plusOnes: z.coerce.number().int().min(0).max(20),
      note: z.string().trim().max(500),
      guestEmail: z.union([z.literal(""), z.email().max(320)]),
    })
    .safeParse({
      guestName: form.get("guestName") ?? "",
      plusOnes: form.get("plusOnes") || 0,
      note: form.get("note") ?? "",
      guestEmail: String(form.get("guestEmail") ?? "")
        .trim()
        .toLowerCase(),
    });
  if (!guest.success) {
    const field = guest.error.issues[0]?.path[0];
    return {
      fieldError:
        field === "plusOnes" ? "plusOnes" : field === "guestEmail" ? "guestEmail" : "guestName",
    };
  }
  return formResult(
    await requestAdvanceGuest(createAnonSupabase(), {
      ...l.data,
      guestName: guest.data.guestName,
      plusOnes: guest.data.plusOnes,
      note: guest.data.note,
      guestEmail: guest.data.guestEmail.length > 0 ? guest.data.guestEmail : null,
    }),
  );
}

/** The crew roster behind a Crew Roster section, names masked until each person accepts. */
export async function listTokenRosterAction(input: {
  token: string;
  accessCode: string;
  sectionId: string;
}): Promise<TokenOutcome<readonly AdvanceRosterEntry[]>> {
  const l = link.safeParse(input);
  if (!l.success) return { ok: false, refusal: "advance_access_code" };
  const result = await listAdvanceRoster(createAnonSupabase(), l.data);
  if (!result.ok) return { ok: false, outcome: outcomeFor(result.error) };
  return result.data.refused
    ? { ok: false, refusal: result.data.reason }
    : { ok: true, data: result.data.entries };
}

/** Invites an address onto the roster through the link; they accept their entry themselves. */
export async function inviteTokenRosterAction(_: FormResult, form: FormData): Promise<FormResult> {
  const l = link.safeParse(linkOf(form));
  if (!l.success) return { outcome: refusalOutcome("advance_access_code") };
  const email = z
    .email()
    .max(320)
    .safeParse(String(form.get("email") ?? "").trim());
  if (!email.success) return { fieldError: "rosterEmail" };
  const arrival = z
    .object({
      from: z.string().trim().max(40),
      to: z.string().trim().max(40),
      zone: z.string().trim().max(64),
    })
    .safeParse({
      from: form.get("arrivalStartsAt") ?? "",
      to: form.get("arrivalEndsAt") ?? "",
      zone: form.get("arrivalTimeZone") ?? "",
    });
  if (!arrival.success || (arrival.data.from === "") !== (arrival.data.to === ""))
    return { fieldError: "rosterArrival" };
  const a = arrival.data;
  return formResult(
    await inviteAdvanceRosterMember(createAnonSupabase(), {
      ...l.data,
      email: email.data,
      arrivalFrom: a.from === "" ? null : localToInstant(a.from, a.zone),
      arrivalTo: a.to === "" ? null : localToInstant(a.to, a.zone),
      arrivalZone: a.from === "" ? null : a.zone || null,
    }),
  );
}

/** Submits the roster through the link: the people who accepted go to the production for review. */
export async function submitTokenRosterAction(_: FormResult, form: FormData): Promise<FormResult> {
  const l = link.safeParse(linkOf(form));
  if (!l.success) return { outcome: refusalOutcome("advance_access_code") };
  return formResult(await submitAdvanceRoster(createAnonSupabase(), l.data));
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
  if (!result.ok) return { ok: false, outcome: outcomeFor(result.error) };
  return result.data.refused
    ? { ok: false, refusal: result.data.reason }
    : { ok: true, data: { signedAt: result.data.signedAt } };
}
