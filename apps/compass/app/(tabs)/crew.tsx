import type { Row } from "@xos/sync";
import { useRouter } from "expo-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { formatElapsed } from "../../src/domain/clock";
import { useCompass, useRows } from "../../src/runtime/CompassProvider";
import { formatTime, Gate, ProjectPicker, SyncBanner, useAllowed } from "../../src/screens/common";
import { Button, Card, ListRow, Screen, Tag, Text } from "../../src/ui";

/**
 * Supervisor mode (Section 4.5.7): who is on site now from open time entries, late arrivals against call
 * times, and the dispatch board. Timesheet approval stays in Atlas until A13's approval RPCs are callable
 * from Compass.
 */
function Crew(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { projectId } = useCompass();
  const canClockTeam = useAllowed("clock.team");
  const now = Date.now();
  const { rows: roster } = useRows<Row & { display_name: string }>("kiosk_roster");
  const { rows: open } = useRows<
    Row & {
      project_id: string;
      membership_id?: string | null;
      clock_in: string;
      clock_out: string | null;
    }
  >("time_entries", (e) => e.project_id === projectId && e.clock_out === null);
  const { rows: shifts } = useRows<
    Row & {
      project_id: string;
      membership_id?: string | null;
      starts_at: string;
      ends_at: string;
      shift_state?: string;
    }
  >("shifts", (s) => s.project_id === projectId && s.shift_state === "Accepted");
  const names = new Map(roster.map((r) => [r.id, r.display_name]));
  const onSite = new Set(open.map((e) => e.membership_id));
  const late = shifts.filter(
    (s) =>
      Date.parse(s.starts_at) < now &&
      Date.parse(s.ends_at) > now &&
      s.membership_id &&
      !onSite.has(s.membership_id),
  );
  return (
    <Screen testID="crew" title={t("compass.crew.title")}>
      <ProjectPicker />
      <SyncBanner />
      <Card title={t("compass.crew.board")}>
        {open.length === 0 ? (
          <Text tone="secondary">{t("compass.crew.boardEmpty")}</Text>
        ) : (
          open.map((e) => (
            <ListRow
              key={e.id}
              icon="user"
              title={names.get(e.membership_id ?? "") ?? ""}
              subtitle={formatTime(e.clock_in)}
              trailing={<Text variant="mono13">{formatElapsed(now - Date.parse(e.clock_in))}</Text>}
            />
          ))
        )}
      </Card>
      {late.length > 0 ? (
        <Card title={t("compass.crew.late")}>
          {late.map((s) => (
            <ListRow
              key={s.id}
              icon="triangle-alert"
              title={names.get(s.membership_id ?? "") ?? ""}
              subtitle={formatTime(s.starts_at)}
              trailing={<Tag label={t("compass.crew.late")} tone="danger" />}
            />
          ))}
        </Card>
      ) : null}
      {canClockTeam ? (
        <Button
          testID="crew-clock-team"
          icon="users"
          label={t("compass.clockTeam.open")}
          onPress={() => router.push("/clock-team")}
        />
      ) : null}
      <Button
        testID="crew-dispatch"
        variant="secondary"
        icon="siren"
        label={t("compass.incidents.dispatchTitle")}
        onPress={() => router.push("/incidents")}
      />
    </Screen>
  );
}

export default function CrewScreen(): ReactElement {
  return (
    <Gate feature="crew.board">
      <Crew />
    </Gate>
  );
}
