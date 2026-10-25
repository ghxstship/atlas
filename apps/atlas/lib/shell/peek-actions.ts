"use server";

import { getRecordByKey, listStateHistory } from "@xos/data/work";
import { z } from "zod";
import {
  loadConversation,
  loadRelations,
  type Conversation,
} from "@/components/work/record-sections";
import type { RecordRelations } from "@/components/work/related-records";
import { getOrgContext } from "./context";
import { rememberView } from "./recents";
import { observability } from "@/lib/observability";

/**
 * What the shell's global peek shows for a record key (Section 4.5.3): the sections of the record's
 * full page (Section 11.2 item 4), read by the same loaders (components/work/record-sections.ts).
 */
export interface ShellPeekRecord {
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly state: string;
  readonly title: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly ownerName: string | null;
  readonly phaseCode: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly dueAt: string | null;
  readonly timeZone: string | null;
  readonly blockerText: string | null;
  /** The latest state changes, newest first (A59-016: the peek shows recent activity). */
  readonly history: readonly {
    readonly id: string;
    readonly from: string | null;
    readonly to: string;
    readonly reason: string;
    readonly at: string;
    readonly byName: string | null;
  }[];
  /** Comments and files, which the viewer may add to unless the record is in Trash. */
  readonly conversation: Conversation;
  readonly inTrash: boolean;
  /** The viewer's person id, to offer deleting their own comments and files. */
  readonly me: string | null;
  readonly relations: RecordRelations;
}

export type ShellPeekResult =
  | { readonly ok: true; readonly record: ShellPeekRecord }
  | { readonly ok: false; readonly reason: "notFound" | "unexpected" };

const KEY = z.string().trim().min(3).max(80);

/**
 * Reads the record a `?peek` key names with the viewer's own client, so row level security decides: a
 * key for a record the viewer may not read, in another org or of no record at all is the same
 * not-found (ADR 0003).
 */
export async function loadShellPeekAction(
  org: string,
  recordKey: string,
): Promise<ShellPeekResult> {
  const key = KEY.safeParse(recordKey);
  const ctx = await getOrgContext(org);
  if (!key.success || !ctx) return { ok: false, reason: "notFound" };
  const found = await getRecordByKey(ctx.viewer.db, ctx.org.id, key.data);
  if (!found.ok) {
    if (found.error.kind === "not-found") return { ok: false, reason: "notFound" };
    observability.logger.error("Shell peek failed", { error: found.error });
    return { ok: false, reason: "unexpected" };
  }
  const r = found.data;
  const read = await Promise.all([
    listStateHistory(ctx.viewer.db, r.id),
    loadConversation(ctx, { table: "app.records", id: r.id }),
    loadRelations(ctx, r.id),
    // The command menu's recent items (Section 11.7).
    rememberView(ctx, "records", r.id),
  ]).catch((error: unknown) => {
    console.error("Shell peek failed", error);
    return null;
  });
  if (read === null) return { ok: false, reason: "unexpected" };
  const [history, conversation, { relations }] = read;
  return {
    ok: true,
    record: {
      id: r.id,
      key: r.key,
      kind: r.kind,
      state: r.state,
      title: r.title,
      projectKey: r.projectKey,
      projectName: r.projectName,
      ownerName: r.ownerName,
      phaseCode: r.phaseCode,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      dueAt: r.dueAt,
      timeZone: r.timeZone ?? r.projectTimeZone,
      blockerText: r.blockerText,
      history: history.ok ? [...history.data].reverse().slice(0, 5) : [],
      conversation,
      inTrash: r.deletedAt !== null,
      me: ctx.viewer.person?.id ?? null,
      relations,
    },
  };
}
