import type { Row } from "@xos/sync";
import { useRouter } from "expo-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { formatElapsed } from "../../src/domain/clock";
import { buildNoShow, lateCrew, markedShiftIds } from "../../src/domain/no-show";
import { useCompass, useRows } from "../../src/runtime/CompassProvider";
import { formatTime, Gate, ProjectPicker, SyncBanner, useAllowed } from "../../src/screens/common";
import { Button, Card, ListRow, Screen, Sheet, Tag, Text, TextField } from "../../src/ui";

/**
 * Supervisor mode (Section 4.5.7): who is on site now from open time entries, late arrivals against call
 * times, and the dispatch board. A late crew member can be marked a no-show (B9), offline too: the mark waits as one
 * queued change and the person leaves the list at once. Timesheet approval stays in Atlas until A13's approval RPCs
 * are callable from Compass.
 */
function Crew(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { projectId, enqueue } = useCompass();
  const canClockTeam = useAllowed("clock.team");
  const canMarkNoShow = useAllowed("crew.no_show");
  // The late row being marked, and what the supervisor saw.
  const [marking, setMarking] = useState<{ id: string; org_id: string; name: string } | null>(null);
  const [reason, setReason] = useState("");
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
      org_id: string;
      membership_id?: string | null;
      starts_at: string;
      ends_at: string;
      shift_state?: string;
    }
  >("shifts", (s) => s.project_id === projectId && s.shift_state === "Accepted");
  const { rows: noShows } = useRows<
    Row & { project_id: string; shift_id: string; deleted_at?: string | null }
  >("shift_no_shows", (n) => n.project_id === projectId);
  const names = new Map(roster.map((r) => [r.id, r.display_name]));
  const onSite = new Set(open.map((e) => e.membership_id));
  const late = lateCrew(shifts, onSite, markedShiftIds(noShows), now);
  const submitNoShow = async () => {
    if (!marking || !projectId || reason.trim() === "") return;
    await enqueue(
      buildNoShow({ shiftId: marking.id, orgId: marking.org_id, projectId, reason }, Date.now()),
    );
    setMarking(null);
    setReason("");
  };
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
              trailing={
                canMarkNoShow ? (
                  <Button
                    testID={`crew-no-show-${s.id}`}
                    variant="secondary"
                    label={t("compass.crew.noShow.mark")}
                    onPress={() =>
                      setMarking({
                        id: s.id,
                        org_id: s.org_id,
                        name: names.get(s.membership_id ?? "") ?? "",
                      })
                    }
                  />
                ) : (
                  <Tag label={t("compass.crew.late")} tone="danger" />
                )
              }
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
      <Sheet
        testID="crew-no-show-sheet"
        open={marking !== null}
        title={t("compass.crew.noShow.title", { name: marking?.name ?? "" })}
        closeLabel={t("compass.crew.noShow.cancel")}
        onClose={() => setMarking(null)}
        footer={
          <Button
            testID="crew-no-show-submit"
            block
            label={t("compass.crew.noShow.submit")}
            disabled={reason.trim() === ""}
            onPress={() => void submitNoShow()}
          />
        }
      >
        <TextField
          testID="crew-no-show-reason"
          label={t("compass.crew.noShow.reason")}
          help={t("compass.crew.noShow.reasonHelp")}
          value={reason}
          onChangeText={setReason}
          multiline
        />
      </Sheet>
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
