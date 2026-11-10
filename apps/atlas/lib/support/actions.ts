"use server";

import type { DataError } from "@xos/data";
import {
  getSupportTicket,
  postSupportMessage,
  transitionSupportTicket,
  type SupportTicketDetail,
  type SupportTicketState,
} from "@xos/data/support";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import * as enums from "@xos/data/enums";

/**
 * Server actions behind the support request drawer (Section 11.16): read one request, reply, and
 * move it through its lifecycle. The RPCs of migration 0643 decide who may do what; a refusal comes
 * back as a `support.errors.*` key.
 */

export type SupportError = "denied" | "closed" | "invalid" | "conflict" | "unexpected" | "notFound";
export type SupportResult<T = null> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: SupportError };

const STATES = enums.supportTicketState;

function errorOf(error: DataError): SupportError {
  if (error.kind === "not-found") return "notFound";
  if (error.kind === "invalid") return "invalid";
  if (error.kind === "conflict") return "conflict";
  if (error.kind === "refusal") {
    if (error.rule === "support_ticket_closed") return "closed";
    if (error.rule === "support_ticket_state_conflict") return "conflict";
    return "denied";
  }
  return error.kind === "unexpected" && error.code === "42501" ? "denied" : "unexpected";
}

async function db(orgSlug: string) {
  const ctx = await getOrgContext(orgSlug);
  return ctx?.viewer.person ? ctx.viewer.db : null;
}

function refresh(orgSlug: string) {
  revalidatePath(`/${orgSlug}/settings/help-and-support`);
  revalidatePath(`/${orgSlug}/me/account`);
}

/** One request with its diagnostics, conversation and next states. */
export async function loadTicketAction(
  orgSlug: string,
  ticketId: string,
): Promise<SupportResult<SupportTicketDetail>> {
  if (!z.uuid().safeParse(ticketId).success) return { ok: false, error: "notFound" };
  const client = await db(orgSlug);
  if (!client) return { ok: false, error: "denied" };
  const result = await getSupportTicket(client, ticketId);
  return result.ok ? { ok: true, data: result.data } : { ok: false, error: errorOf(result.error) };
}

/** Replies on a request as its requester or a responder. */
export async function replyTicketAction(
  orgSlug: string,
  ticketId: string,
  body: string,
): Promise<SupportResult> {
  const text = body.trim();
  if (!z.uuid().safeParse(ticketId).success || text === "" || text.length > 10000) {
    return { ok: false, error: "invalid" };
  }
  const client = await db(orgSlug);
  if (!client) return { ok: false, error: "denied" };
  const result = await postSupportMessage(client, ticketId, text);
  if (!result.ok) return { ok: false, error: errorOf(result.error) };
  refresh(orgSlug);
  return { ok: true, data: null };
}

/** Moves a request to its next state with a reason. */
export async function moveTicketAction(
  orgSlug: string,
  input: {
    ticketId: string;
    expected: SupportTicketState;
    next: SupportTicketState;
    reason: string;
  },
): Promise<SupportResult> {
  const parsed = z
    .object({
      ticketId: z.uuid(),
      expected: z.enum(STATES),
      next: z.enum(STATES),
      reason: z.string().trim().min(1).max(500),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const client = await db(orgSlug);
  if (!client) return { ok: false, error: "denied" };
  const result = await transitionSupportTicket(client, parsed.data);
  if (!result.ok) return { ok: false, error: errorOf(result.error) };
  refresh(orgSlug);
  return { ok: true, data: null };
}
