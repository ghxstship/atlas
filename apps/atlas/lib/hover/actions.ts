"use server";

import { getPersonCard, type PersonCard } from "@xos/data/person-card";
import { getRecordByKey } from "@xos/data/work";
import type { RecordKind } from "@xos/ui";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import type { RecordPreview } from "@/components/hover/use-hover-cards";
import { formatScheduleTime, scheduleViewOf, stateToken } from "@/components/work/format";
import { getOrgContext } from "@/lib/shell/context";
import { getShellSettings } from "@/lib/shell/org-settings";
import { getTranslate } from "@/lib/shell/translate";

const input = z.object({ org: z.string().min(1).max(80), personId: z.uuid() });
const keyInput = z.object({ org: z.string().min(1).max(80), recordKey: z.string().min(1).max(64) });

/**
 * A person's hover card (Section 11.7), read as the viewer: row level security decides who shows.
 * Null when the person is not visible to the viewer or the org is gone.
 */
export async function personCardAction(org: string, personId: string): Promise<PersonCard | null> {
  const parsed = input.safeParse({ org, personId });
  if (!parsed.success) return null;
  const ctx = await getOrgContext(parsed.data.org);
  if (!ctx) return null;
  const card = await getPersonCard(ctx.viewer.db, ctx.org.id, parsed.data.personId);
  return card.ok ? card.data : null;
}

/**
 * A record's hover card by its key (Section 11.7), for keys a page shows without the record, such
 * as an Activity line's: read as the viewer, so a record they cannot read is null. The next date is
 * the start still ahead, else the due or end, in the zone the viewer reads schedule times in.
 */
export async function recordCardAction(
  org: string,
  recordKey: string,
): Promise<RecordPreview | null> {
  const parsed = keyInput.safeParse({ org, recordKey });
  if (!parsed.success) return null;
  const ctx = await getOrgContext(parsed.data.org);
  if (!ctx) return null;
  const db = ctx.viewer.db;
  const [found, shell, t, locale] = await Promise.all([
    getRecordByKey(db, ctx.org.id, parsed.data.recordKey),
    getShellSettings(db, ctx.org.id, null),
    getTranslate(),
    getLocale(),
  ]);
  if (!found.ok) return null;
  const r = found.data;
  const at =
    r.startsAt && r.startsAt > new Date().toISOString()
      ? r.startsAt
      : (r.dueAt ?? r.endsAt ?? r.startsAt);
  const view = scheduleViewOf(shell.preferences, shell.viewerTimeZone);
  return {
    recordKey: r.key,
    recordKind: r.kind as RecordKind,
    title: r.title,
    state: stateToken(r.state),
    stateLabel: t(`work.states.${r.state}`),
    owner: r.ownerName ?? t("work.values.unassigned"),
    next:
      formatScheduleTime(at, locale, r.timeZone ?? r.projectTimeZone, view) ??
      t("work.values.noDate"),
  };
}
