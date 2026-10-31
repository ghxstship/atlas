/**
 * Clock in team (R12, parity addition G-126): a supervisor punches the people they supervise in or out at once,
 * offline too. Internal field supervisors see today's shifts of the project with someone on them; a staffing
 * agency's lead sees the shifts of its roster staff with their names (api_external.shifts). The whole selection
 * queues as one team punch (app.record_supervisor_punches); each worker's answer shows beside their name once it
 * syncs, and who is in follows the synced time entries, so a worker who clocked in on their own phone shows In. The database decides who may be punched: crew.shift.write on the project, or leading the roster.
 */
import { stampEvent, type Row } from "@xos/sync";
import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  buildSupervisorPunchBatch,
  primaryTeamPunch,
  TEAM_PUNCH_LIMIT,
  TEAM_PUNCH_TABLE,
  teamClockState,
  teamShifts,
  type TeamPunchBatch,
  type TeamShiftRow,
  type TeamTimeEntry,
} from "../domain/clock";
import { evaluateGeofence, parseGeoShape, samplingPlan, type Geofence } from "../domain/geo";
import { useCompass, useRows } from "../runtime/CompassProvider";
import { useLocation } from "../runtime/location";
import { deviceClock } from "../runtime/platform";
import { Button, Card, EmptyState, InlineAlert, ListRow, Switch, Tag, Text } from "../ui";
import { formatTime, ProjectPicker, SyncBanner } from "./common";

const C = "compass.clockTeam";

export function ClockTeam(): ReactElement {
  const { t } = useTranslation();
  const { projectId, enqueue, refresh } = useCompass();
  const now = Date.now();
  const { rows: shiftRows } = useRows<TeamShiftRow>("shifts", (s) => s.project_id === projectId);
  const { rows: roster } = useRows<Row & { display_name: string }>("kiosk_roster");
  const { rows: batches } = useRows<TeamPunchBatch & Row>(
    TEAM_PUNCH_TABLE,
    (b) => b.project_id === projectId,
  );
  // Who is in comes from the synced time: the worker's open entry, whoever punched it.
  const { rows: entries } = useRows<TeamTimeEntry & Row>(
    "time_entries",
    (e) => e.project_id === projectId,
  );
  const { rows: punches } = useRows<Row>("clock_punches", (p) => p["project_id"] === projectId);
  const { rows: shapes } = useRows<Row & { name: string; boundary_geojson: unknown }>(
    "geofence_shapes",
  );
  const plan = samplingPlan({
    battery: { level: 1, charging: false, lowPowerMode: false },
    onShift: false,
    minutesToCall: null,
    punching: true,
    batterySaver: false,
  });
  const { fix } = useLocation(plan);
  const geofences: Geofence[] = shapes.flatMap((s) => {
    const boundary = parseGeoShape(s.boundary_geojson);
    return boundary ? [{ id: s.id, name: s.name, boundary }] : [];
  });
  const team = useMemo(() => teamShifts(shiftRows, projectId, now), [shiftRows, projectId, now]);
  const names = new Map(roster.map((r) => [r.id, r.display_name]));
  const nameOf = (s: TeamShiftRow): string =>
    s.holder_name ??
    (s.membership_id ? names.get(s.membership_id) : undefined) ??
    s.job_title ??
    t(`${C}.unnamed`);
  const state = teamClockState(team, entries, punches, batches);
  // The newest answer for each shift, for a refusal beside the name.
  const latest = new Map<string, { outcome: string; code: string | null }>();
  for (const b of [...batches].sort((a, z) => a.device_time.localeCompare(z.device_time))) {
    for (const r of b.results) latest.set(r.shift_id, { outcome: r.outcome, code: r.code });
  }
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const chosen = selected.filter((id) => team.some((s) => s.id === id));
  const primary = primaryTeamPunch(chosen, state);
  const secondary = primary === "In" ? "Out" : "In";
  const allSelected = team.length > 0 && chosen.length === team.length;
  const toggle = (id: string, on: boolean) =>
    setSelected((current) => (on ? [...current, id] : current.filter((x) => x !== id)));
  const punch = async (kind: "In" | "Out") => {
    if (chosen.length === 0 || busy) return;
    setBusy(true);
    try {
      await enqueue(
        buildSupervisorPunchBatch(
          kind,
          String(projectId),
          team
            .filter((s) => chosen.includes(s.id))
            .slice(0, TEAM_PUNCH_LIMIT)
            .map((s) => ({ shiftId: s.id, name: nameOf(s) })),
          stampEvent(deviceClock, null),
          fix,
          geofences,
          Date.now(),
        ),
      );
      setSelected([]);
    } finally {
      setBusy(false);
    }
  };
  const geofence = evaluateGeofence(fix, geofences, now);
  return (
    <>
      <ProjectPicker />
      <SyncBanner />
      {team.length === 0 ? (
        <EmptyState
          testID="clock-team-empty"
          icon="users"
          sentence={t(`${C}.empty`)}
          actionLabel={t(`${C}.refresh`)}
          onAction={() => void refresh()}
        />
      ) : (
        <Card
          testID="clock-team-list"
          title={t(`${C}.listTitle`)}
          meta={t(`${C}.selected`, { count: chosen.length })}
        >
          <Switch
            testID="clock-team-select-all"
            label={t(`${C}.selectAll`)}
            value={allSelected}
            onChange={(on) => setSelected(on ? team.map((s) => s.id) : [])}
          />
          {team.map((s) => {
            const answer = latest.get(s.id);
            const clocked = state.get(s.id) === "in";
            return (
              <ListRow
                key={s.id}
                testID={`clock-team-row-${s.id}`}
                title={nameOf(s)}
                subtitle={
                  answer?.outcome === "refused" && answer.code
                    ? t(`${C}.refusals.${answer.code}`, { defaultValue: t(`${C}.refused`) })
                    : t(`${C}.window`, {
                        start: formatTime(s.starts_at, s.time_zone),
                        end: formatTime(s.ends_at, s.time_zone),
                      })
                }
                trailing={
                  <>
                    {answer?.outcome === "pending" ? (
                      <Tag label={t(`${C}.pending`)} tone="neutral" />
                    ) : clocked ? (
                      <Tag testID={`clock-team-in-${s.id}`} label={t(`${C}.in`)} tone="success" />
                    ) : null}
                    <Switch
                      testID={`clock-team-select-${s.id}`}
                      label={t(`${C}.select`, { name: nameOf(s) })}
                      value={chosen.includes(s.id)}
                      onChange={(on) => toggle(s.id, on)}
                    />
                  </>
                }
              />
            );
          })}
        </Card>
      )}
      {geofence.kind === "outside" ? (
        <InlineAlert tone="warning" message={t(`${C}.outsideGeofence`)} />
      ) : null}
      {team.length > 0 ? (
        <>
          <Text tone="secondary" variant="text13">
            {t(`${C}.hint`)}
          </Text>
          <Button
            testID="clock-team-primary"
            block
            icon={primary === "In" ? "clock" : "log-out"}
            label={t(primary === "In" ? `${C}.clockIn` : `${C}.clockOut`)}
            disabled={chosen.length === 0}
            loading={busy}
            onPress={() => void punch(primary)}
          />
          <Button
            testID="clock-team-secondary"
            variant="secondary"
            block
            label={t(secondary === "In" ? `${C}.clockIn` : `${C}.clockOut`)}
            disabled={chosen.length === 0 || busy}
            onPress={() => void punch(secondary)}
          />
        </>
      ) : null}
    </>
  );
}
