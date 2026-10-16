/**
 * The clock as a screen hook: local punches and time entries, today's shift, geofences, the location
 * sampled on the battery budget, and the punch action.
 */
import { stampEvent, type Row } from "@xos/sync";
import { useEffect, useMemo, useState } from "react";
import { operationalEngagements } from "../domain/access";
import {
  buildPunch,
  checkPunch,
  deriveClock,
  forgottenClockOut,
  type ClockSnapshot,
  type Punch,
  type PunchKind,
  type PunchRefusal,
} from "../domain/clock";
import {
  evaluateGeofence,
  parseGeoShape,
  samplingPlan,
  type Geofence,
  type GeofenceStatus,
} from "../domain/geo";
import { useCompass, useRows } from "../runtime/CompassProvider";
import { useLocation } from "../runtime/location";
import { deviceClock } from "../runtime/platform";

interface ShiftRow extends Row {
  readonly project_id: string;
  readonly membership_id?: string | null;
  readonly engagement_id?: string | null;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly shift_state?: string;
  readonly job_title?: string | null;
  readonly time_zone?: string;
}

interface EntryRow extends Row {
  readonly project_id: string;
  readonly membership_id?: string | null;
  readonly engagement_id?: string | null;
  readonly clock_in: string;
  readonly clock_out: string | null;
  readonly break_minutes: number;
}

/** A server time entry as synthetic punches, for externals who see entries but not raw punches. */
export function entryPunches(entry: EntryRow): Punch[] {
  const base = {
    project_id: entry.project_id,
    shift_id: null,
    membership_id: entry.membership_id ?? null,
    engagement_id: entry.engagement_id ?? null,
    source: "Mobile" as const,
  };
  const out: Punch[] = [
    { ...base, id: `${entry.id}:in`, punch_kind: "In", device_time: entry.clock_in },
  ];
  if (entry.clock_out)
    out.push({ ...base, id: `${entry.id}:out`, punch_kind: "Out", device_time: entry.clock_out });
  return out;
}

export interface ClockModel {
  readonly snapshot: ClockSnapshot;
  readonly geofence: GeofenceStatus;
  readonly forgotten: boolean;
  readonly shift: ShiftRow | null;
  readonly locationDenied: boolean;
  readonly refusal: (kind: PunchKind) => PunchRefusal | null;
  readonly punch: (kind: PunchKind) => Promise<void>;
  readonly now: number;
}

export function useClock(punching: boolean): ClockModel {
  const { resolved, projectId, enqueue, settings } = useCompass();
  const identity = resolved?.identity;
  const engagement = identity ? (operationalEngagements(identity, projectId)[0] ?? null) : null;
  const mine = (r: { membership_id?: string | null; engagement_id?: string | null }) =>
    (typeof identity?.membershipId === "string" && r.membership_id === identity.membershipId) ||
    (engagement !== null && r.engagement_id === engagement.id);
  const { rows: punches } = useRows<Punch & Row>("clock_punches", mine);
  const { rows: entries } = useRows<EntryRow>("time_entries", mine);
  const { rows: shifts } = useRows<ShiftRow>(
    "shifts",
    (s) => mine(s) && s.project_id === projectId,
  );
  const { rows: shapes } = useRows<Row & { name: string; boundary_geojson: unknown }>(
    "geofence_shapes",
  );
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const allPunches = useMemo(
    () => [...entries.flatMap(entryPunches), ...punches],
    [entries, punches],
  );
  const snapshot = deriveClock(allPunches, now);
  const shift =
    shifts
      .filter((s) => s.shift_state === undefined || s.shift_state === "Accepted")
      .find((s) => Date.parse(s.starts_at) - 2 * 3600_000 <= now && Date.parse(s.ends_at) >= now) ??
    null;
  const next = shifts
    .map((s) => Date.parse(s.starts_at))
    .filter((t) => t > now)
    .sort((a, b) => a - b)[0];
  const plan = samplingPlan({
    battery: { level: 1, charging: false, lowPowerMode: false },
    onShift: snapshot.state !== "out",
    minutesToCall: next === undefined ? null : (next - now) / 60_000,
    punching,
    batterySaver: settings.batterySaver,
  });
  const { fix, permission } = useLocation(plan);
  const geofences: Geofence[] = shapes.flatMap((s) => {
    const boundary = parseGeoShape(s.boundary_geojson);
    return boundary ? [{ id: s.id, name: s.name, boundary }] : [];
  });
  const geofence = evaluateGeofence(fix, geofences, now);
  const policy = { requireGeofence: geofences.length > 0, requireShift: false };

  return {
    snapshot,
    geofence,
    forgotten: forgottenClockOut(allPunches, now),
    shift,
    locationDenied: permission === "denied",
    now,
    refusal: (kind) => checkPunch(kind, snapshot, geofence, policy, shift !== null),
    punch: async (kind) => {
      if (!projectId || !identity) return;
      const input = buildPunch(
        kind,
        {
          projectId,
          shiftId: shift?.id ?? null,
          membershipId: identity.membershipId,
          engagementId: identity.membershipId ? null : (engagement?.id ?? null),
          source: "Mobile",
        },
        stampEvent(deviceClock, null),
        fix,
        geofences,
        Date.now(),
      );
      await enqueue(input);
    },
  };
}
