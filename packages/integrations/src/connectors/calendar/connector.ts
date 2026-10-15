import type { ProviderCode } from "../../framework/catalog.ts";
import { ItemTally, type Connector, type SyncContext } from "../../framework/connector.ts";
import { StoreError } from "../../framework/db.ts";
import { IntegrationError } from "../../framework/errors.ts";
import type { ExternalId } from "../../framework/store.ts";
import { contentHash } from "../../framework/support.ts";
import type { CalendarItem, CalendarSource, CalendarTarget } from "./source.ts";

/** What XOS writes to a provider calendar for one item. Instants are ISO 8601 in UTC. */
export interface CalendarEvent {
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string | null;
  readonly location: string | null;
  readonly conferencingUri: string | null;
  readonly localId: string;
}

export interface WrittenEvent {
  readonly externalId: string;
  readonly version: string | null;
}

/** A provider event as a change feed reports it. */
export interface ProviderEvent {
  readonly externalId: string;
  readonly version: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly updatedAt: string;
  readonly removed: boolean;
}

export interface ChangePage {
  readonly events: readonly ProviderEvent[];
  readonly cursor: string | null;
}

export interface CalendarProvider {
  readonly provider: ProviderCode;
  readonly label: string;
  /** Updates the event when externalId is given, else creates it. */
  writeEvent(
    context: SyncContext,
    calendarId: string,
    externalId: string | null,
    event: CalendarEvent,
  ): Promise<WrittenEvent>;
  removeEvent(context: SyncContext, calendarId: string, externalId: string): Promise<void>;
  changes(context: SyncContext, calendarId: string, cursor: string | null): Promise<ChangePage>;
}

/** Normalizes an instant to ISO 8601 UTC with milliseconds, so hashes and comparisons agree across providers. */
export function utc(instant: string): string {
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime()))
    throw new IntegrationError("instant_malformed", `${instant} is not a date and time.`);
  return parsed.toISOString();
}

function eventFor(item: CalendarItem): CalendarEvent {
  return {
    title: item.title,
    startsAt: utc(item.startsAt),
    endsAt: utc(item.endsAt),
    timeZone: item.timeZone,
    location: item.location,
    conferencingUri: item.conferencingUri,
    localId: item.localId,
  };
}

/** Hash of what was last written for an item, so unchanged items are skipped and local edits are detected. */
function itemHash(item: CalendarItem, startsAt = item.startsAt, endsAt = item.endsAt): string {
  return contentHash({ ...eventFor({ ...item, startsAt, endsAt }), canceled: item.canceled });
}

function parseCursors(cursor: string | null): Map<string, string> {
  if (cursor === null) return new Map();
  try {
    const parsed = JSON.parse(cursor) as unknown;
    if (parsed === null || typeof parsed !== "object") return new Map();
    return new Map(
      Object.entries(parsed as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    );
  } catch {
    // A cursor from another format restarts the change feed from scratch, which is safe: changes are idempotent.
    return new Map();
  }
}

const inbound = (run: SyncContext["run"], target: CalendarTarget) =>
  run.direction !== "Outbound" && target.direction !== "Outbound";
const outbound = (run: SyncContext["run"], target: CalendarTarget) =>
  run.direction !== "Inbound" && target.direction !== "Inbound";

async function pullTarget(
  provider: CalendarProvider,
  source: CalendarSource,
  context: SyncContext,
  target: CalendarTarget,
  items: Map<string, CalendarItem>,
  pairs: Map<string, ExternalId>,
  cursor: string | null,
  tally: ItemTally,
): Promise<string | null> {
  const page = await provider.changes(context, target.externalCalendarId, cursor);
  const byExternal = new Map([...pairs.values()].map((p) => [p.externalId, p]));
  for (const change of page.events) {
    const pair = byExternal.get(change.externalId);
    const item = pair ? items.get(pair.localId) : undefined;
    if (!pair || !item) continue; // Not an event XOS placed on this target.
    tally.read += 1;
    if (
      change.removed ||
      change.startsAt === null ||
      change.endsAt === null ||
      (change.version !== null && change.version === pair.externalVersion)
    ) {
      // Removal on the provider side never deletes XOS work; the next outbound pass puts the event back.
      tally.skipped += 1;
      continue;
    }
    const startsAt = utc(change.startsAt);
    const endsAt = utc(change.endsAt);
    if (startsAt === utc(item.startsAt) && endsAt === utc(item.endsAt)) {
      tally.skipped += 1;
      continue;
    }
    const localChanged = pair.contentHash !== null && pair.contentHash !== itemHash(item);
    const providerWins =
      !localChanged ||
      target.conflictPolicy === "Provider Wins" ||
      (target.conflictPolicy === "Latest Wins" &&
        new Date(change.updatedAt).getTime() > new Date(item.updatedAt).getTime());
    if (!providerWins) {
      tally.skipped += 1;
      continue;
    }
    try {
      await source.applyChange(
        context.connection.id,
        item.entity,
        item.localId,
        startsAt,
        endsAt,
        change.version,
      );
    } catch (error) {
      if (!(error instanceof StoreError && error.error.kind === "refusal")) throw error;
      await tally.fail(error.error.rule, error.error.message, {
        entity: item.entity,
        localId: item.localId,
        externalId: change.externalId,
      });
      continue;
    }
    const moved: CalendarItem = { ...item, startsAt, endsAt };
    items.set(item.localId, moved);
    // When XOS also changed the item, keep the old hash so the outbound pass sends the XOS edits with the new times.
    const updated: ExternalId = {
      ...pair,
      externalVersion: change.version,
      contentHash: localChanged ? pair.contentHash : itemHash(moved),
    };
    pairs.set(item.localId, updated);
    await context.store.upsertExternalId(context.connection.id, updated);
    tally.written += 1;
  }
  return page.cursor;
}

async function pushTarget(
  provider: CalendarProvider,
  context: SyncContext,
  target: CalendarTarget,
  items: ReadonlyMap<string, CalendarItem>,
  pairs: Map<string, ExternalId>,
  tally: ItemTally,
) {
  for (const item of items.values()) {
    tally.read += 1;
    const pair = pairs.get(item.localId);
    const hash = itemHash(item);
    if (pair?.contentHash === hash || (!pair && item.canceled)) {
      tally.skipped += 1;
      continue;
    }
    if (item.canceled && pair) {
      await provider.removeEvent(context, target.externalCalendarId, pair.externalId);
      const removed: ExternalId = { ...pair, contentHash: hash };
      pairs.set(item.localId, removed);
      await context.store.upsertExternalId(context.connection.id, removed);
      tally.written += 1;
      continue;
    }
    let written: WrittenEvent;
    try {
      written = await provider.writeEvent(
        context,
        target.externalCalendarId,
        pair?.externalId ?? null,
        eventFor(item),
      );
    } catch (error) {
      if (!(error instanceof IntegrationError && error.code === "provider_not_found" && pair))
        throw error;
      // Someone deleted the event in the provider calendar: XOS still holds the item, so place it again.
      written = await provider.writeEvent(context, target.externalCalendarId, null, eventFor(item));
    }
    const next: ExternalId = {
      entity: item.entity,
      localId: item.localId,
      externalId: written.externalId,
      externalVersion: written.version,
      contentHash: hash,
    };
    pairs.set(item.localId, next);
    await context.store.upsertExternalId(context.connection.id, next);
    tally.written += 1;
  }
}

/** Two-way calendar sync for Meeting, Event and Shift items through one provider. */
export function calendarConnector(provider: CalendarProvider, source: CalendarSource): Connector {
  return {
    provider: provider.provider,
    scopes: ["Calendar Sync"],
    async sync(context) {
      const tally = new ItemTally(context);
      const cursors = parseCursors(context.cursor);
      const pairs = new Map<string, ExternalId>();
      for (const entity of ["Record", "Shift"] as const) {
        for (const pair of await context.store.externalIds(context.connection.id, entity))
          pairs.set(pair.localId, pair);
      }
      for (const target of await source.targets(context.connection.id)) {
        const items = new Map((await source.items(target.id)).map((i) => [i.localId, i]));
        const targetPairs = new Map([...pairs].filter(([localId]) => items.has(localId)));
        if (inbound(context.run, target)) {
          const next = await pullTarget(
            provider,
            source,
            context,
            target,
            items,
            targetPairs,
            cursors.get(target.id) ?? null,
            tally,
          );
          if (next === null) cursors.delete(target.id);
          else cursors.set(target.id, next);
        }
        if (outbound(context.run, target))
          await pushTarget(provider, context, target, items, targetPairs, tally);
      }
      return { counts: tally.counts(), cursorAfter: JSON.stringify(Object.fromEntries(cursors)) };
    },
  };
}
