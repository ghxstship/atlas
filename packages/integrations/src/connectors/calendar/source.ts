import type { SyncDirection } from "../../framework/catalog.ts";
import { unwrap, type DbClient } from "../../framework/db.ts";

export type CalendarKind = "Meeting" | "Event" | "Shift";
export type ConflictPolicy = "XOS Wins" | "Provider Wins" | "Latest Wins";

export interface CalendarTarget {
  readonly id: string;
  readonly projectId: string | null;
  readonly kind: CalendarKind;
  readonly externalCalendarId: string;
  readonly direction: SyncDirection;
  readonly conflictPolicy: ConflictPolicy;
}

/** One row of app.integration_calendar_items (migration 0620). */
export interface CalendarItem {
  readonly entity: "Record" | "Shift";
  readonly localId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string | null;
  readonly location: string | null;
  readonly conferencingUri: string | null;
  readonly canceled: boolean;
  readonly updatedAt: string;
}

export interface CalendarSource {
  targets(connectionId: string): Promise<readonly CalendarTarget[]>;
  items(targetId: string): Promise<readonly CalendarItem[]>;
  applyChange(
    connectionId: string,
    entity: "Record" | "Shift",
    localId: string,
    startsAt: string,
    endsAt: string,
    version: string | null,
  ): Promise<boolean>;
}

interface TargetRow {
  id: string;
  project_id: string | null;
  sync_kind: CalendarKind;
  external_calendar_id: string;
  direction: SyncDirection;
  conflict_policy: ConflictPolicy;
}

interface ItemRow {
  entity: "Record" | "Shift";
  local_id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  time_zone: string | null;
  location_text: string | null;
  conferencing_uri: string | null;
  canceled: boolean;
  updated_at: string;
}

export function supabaseCalendarSource(db: DbClient): CalendarSource {
  return {
    async targets(connectionId) {
      const rows = await unwrap<TargetRow[]>(
        db
          .from("integration_calendar_targets")
          .select("id, project_id, sync_kind, external_calendar_id, direction, conflict_policy")
          .eq("integration_connection_id", connectionId)
          .is("deleted_at", null)
          .order("created_at"),
      );
      return rows.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        kind: r.sync_kind,
        externalCalendarId: r.external_calendar_id,
        direction: r.direction,
        conflictPolicy: r.conflict_policy,
      }));
    },
    async items(targetId) {
      const rows = await unwrap<ItemRow[]>(
        db
          .from("integration_calendar_items")
          .select("*")
          .eq("integration_calendar_target_id", targetId)
          .order("starts_at"),
      );
      return rows.map((r) => ({
        entity: r.entity,
        localId: r.local_id,
        title: r.title,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        timeZone: r.time_zone,
        location: r.location_text,
        conferencingUri: r.conferencing_uri,
        canceled: r.canceled,
        updatedAt: r.updated_at,
      }));
    },
    async applyChange(connectionId, entity, localId, startsAt, endsAt, version) {
      return unwrap<boolean>(
        db.rpc("apply_calendar_change", {
          p_connection_id: connectionId,
          p_entity: entity,
          p_local_id: localId,
          p_starts_at: startsAt,
          p_ends_at: endsAt,
          p_external_version: version,
        }),
      );
    },
  };
}
