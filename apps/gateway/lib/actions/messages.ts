"use server";

import { markThreadRead, startPartyThread, toDisplayKey } from "@xos/data/gateway";
import { z } from "zod";
import { outcomeFor } from "@/lib/action-result";
import { getGatewayContext } from "@/lib/shell/context";
import { createServerSupabase } from "@/lib/supabase/server";

/** Messages actions (A28b 0773): start a conversation with an org, and mark a thread read. */

export interface StartThreadState {
  readonly outcome?: string;
  readonly fieldError?: string;
  readonly threadKey?: string;
}

export async function startPartyThreadAction(
  _: StartThreadState,
  form: FormData,
): Promise<StartThreadState> {
  const ctx = await getGatewayContext();
  if (!ctx) return { outcome: "notFound" };
  const parsed = z
    .object({
      orgId: z.uuid(),
      subject: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(4000),
    })
    .safeParse({ orgId: form.get("orgId"), subject: form.get("subject"), body: form.get("body") });
  if (!parsed.success) return { fieldError: "start" };
  const result = await startPartyThread(ctx.db, {
    ...parsed.data,
    personId: ctx.acting ? null : ctx.personId,
    accountId: ctx.acting?.id ?? null,
  });
  if (!result.ok) return { outcome: outcomeFor(result.error) };
  return { threadKey: toDisplayKey("thread", result.data.threadId) };
}

export async function markReadAction(
  kind: "engagement" | "party",
  threadId: string,
): Promise<void> {
  const id = z.uuid().parse(threadId);
  const result = await markThreadRead(
    await createServerSupabase(),
    kind === "engagement" ? { engagementThreadId: id } : { partyThreadId: id },
  );
  if (!result.ok) console.error("mark_thread_read did not record the read", result.error);
}
