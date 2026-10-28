"use server";

import { getFieldHistory } from "@xos/data/field-history";
import {
  getRecordByKey,
  getRecordExtension,
  listCurrencyOptions,
  listPeopleRefs,
  listPhaseOptions,
  listStateHistory,
} from "@xos/data/work";
import { getFormatter, getLocale } from "next-intl/server";
import { z } from "zod";
import type { HistoryItem } from "@/components/history/field-history-list";
import { kindFields } from "@/components/work/kind-fields";
import { recordHistoryItems } from "@/components/work/record-history-items";
import {
  loadConversation,
  loadRelations,
  type Conversation,
} from "@/components/work/record-sections";
import type { RecordRelations } from "@/components/work/related-records";
import { getOrgContext } from "./context";
import { rememberView } from "./recents";
import { observability } from "@/lib/observability";
import { getTranslate } from "./translate";

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
  /** The field history (Section 4.10, A131), worded on the server; null when it could not be read. */
  readonly fieldHistory: readonly HistoryItem[] | null;
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
  const db = ctx.viewer.db;
  const read = await Promise.all([
    listStateHistory(db, r.id),
    loadConversation(ctx, { table: "app.records", id: r.id }),
    loadRelations(ctx, r.id),
    fieldHistoryOf(ctx, r),
    // The command menu's recent items (Section 11.7).
    rememberView(ctx, "records", r.id),
  ]).catch((error: unknown) => {
    observability.logger.error("Shell peek failed", { error });
    return null;
  });
  if (read === null) return { ok: false, reason: "unexpected" };
  const [history, conversation, { relations }, fieldHistory] = read;
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
      fieldHistory,
      conversation,
      inTrash: r.deletedAt !== null,
      me: ctx.viewer.person?.id ?? null,
      relations,
    },
  };
}

/**
 * The record's field history as its full page words it (record-history-items.ts), with instants in
 * the record's time zone. A failed read leaves the section out rather than failing the peek.
 */
async function fieldHistoryOf(
  ctx: NonNullable<Awaited<ReturnType<typeof getOrgContext>>>,
  r: {
    readonly id: string;
    readonly kind: string;
    readonly timeZone: string | null;
    readonly projectTimeZone: string;
  },
): Promise<HistoryItem[] | null> {
  const db = ctx.viewer.db;
  const [events, people, phases, fields, extension, currencies, t, format, locale] =
    await Promise.all([
      getFieldHistory(db, "app.records", r.id),
      listPeopleRefs(db, ctx.org.id),
      listPhaseOptions(db),
      kindFields(ctx, r.kind),
      getRecordExtension(db, r.kind, r.id),
      listCurrencyOptions(db),
      getTranslate(),
      getFormatter(),
      getLocale(),
    ]);
  if (!events.ok) return null;
  const timeZone = r.timeZone ?? r.projectTimeZone;
  return recordHistoryItems(events.data, {
    t,
    locale,
    when: (iso) =>
      format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short", timeZone }),
    at: (iso) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" }),
    number: (n) => format.number(n),
    day: (d) =>
      format.dateTime(new Date(`${d}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" }),
    names: Object.fromEntries(
      (people.ok ? people.data : []).map((p) => [p.personId, p.name ?? t("work.values.unnamed")]),
    ),
    phases: phases.ok ? phases.data : [],
    fields,
    extension: extension.ok ? extension.data : {},
    currencies: currencies.ok ? currencies.data : [],
  });
}
