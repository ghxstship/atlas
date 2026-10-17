import type { Row } from "@xos/sync";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { access, operationalEngagements, todayBlocks } from "../../src/domain/access";
import { isMine } from "../../src/domain/shifts";
import {
  formatElapsed,
  needsPreciseFix,
  primaryPunch,
  secondaryPunches,
  workedMs,
  type PunchKind,
  type PunchRefusal,
} from "../../src/domain/clock";
import { formatCountdown, showState, type Cue } from "../../src/domain/show";
import { punchAnnouncementKey } from "../../src/domain/announce";
import { useCompass, useRows } from "../../src/runtime/CompassProvider";
import {
  formatDay,
  formatTime,
  ProjectPicker,
  SyncBanner,
  useRoleTitle,
} from "../../src/screens/common";
import { useClock } from "../../src/screens/useClock";
import {
  announce,
  Button,
  Card,
  ClockButton,
  EmptyState,
  InlineAlert,
  LiveActivity,
  Screen,
  ShiftCard,
  Text,
  useTheme,
} from "../../src/ui";

const PUNCH_LABEL: Readonly<Record<PunchKind, string>> = {
  In: "compass.clock.in",
  "Break Start": "compass.clock.startBreak",
  "Break End": "compass.clock.endBreak",
  Out: "compass.clock.out",
};

const REFUSAL_KEY: Readonly<Record<PunchRefusal, string>> = {
  "already-in": "compass.clock.refusal.alreadyIn",
  "not-clocked-in": "compass.clock.refusal.notClockedIn",
  "not-on-break": "compass.clock.refusal.notOnBreak",
  "already-on-break": "compass.clock.refusal.alreadyOnBreak",
  "outside-geofence": "compass.clock.refusal.outsideGeofence",
  "location-unknown": "compass.clock.refusal.locationUnknown",
  "not-rostered": "compass.clock.refusal.notRostered",
};

function ClockCard(): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { settings, status } = useCompass();
  const [punching, setPunching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Today is the clock: while it is in front and the person is clocked out, sample precisely so Clock In
  // has a fix to decide on (the battery plan alone turns location off away from a call time).
  const [open, setOpen] = useState(false);
  const [clockedOut, setClockedOut] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setOpen(true);
      return () => setOpen(false);
    }, []),
  );
  const clock = useClock(needsPreciseFix(open, clockedOut ? "out" : "on", punching));
  useEffect(() => setClockedOut(clock.snapshot.state === "out"), [clock.snapshot.state]);
  const primary = primaryPunch(clock.snapshot.state);
  const refusal = clock.refusal(primary);
  const geofenceText = (() => {
    const g = clock.geofence;
    if (clock.locationDenied) return t("compass.clock.locationOff");
    if (g.kind === "inside") return t("compass.clock.inside", { name: g.geofence.name });
    if (g.kind === "outside")
      return g.nearest && g.distanceM !== null && g.distanceM < 5000
        ? t("compass.clock.outside", { distance: Math.round(g.distanceM), name: g.nearest.name })
        : t("compass.clock.outsideFar");
    if (g.kind === "unknown")
      return t(g.reason === "coarse" ? "compass.clock.locationCoarse" : "compass.clock.locating");
    return t("compass.clock.unfenced");
  })();
  const run = async (kind: PunchKind) => {
    const refused = clock.refusal(kind);
    if (refused) {
      setNotice(t(REFUSAL_KEY[refused]));
      return;
    }
    setPunching(true);
    await clock.punch(kind);
    setPunching(false);
    setNotice(status?.online ? null : t("compass.clock.queued"));
    announce(t(punchAnnouncementKey(kind, status?.online ?? false)));
  };
  const label =
    clock.snapshot.state === "out"
      ? t("compass.clock.in")
      : clock.snapshot.state === "break"
        ? t("compass.clock.onBreak")
        : t("compass.clock.onShift");
  if (clock.snapshot.state !== "out") {
    // On shift: the Live Activity summary with its break toggle and clock out (Section 11.13 Clock).
    return (
      <View style={{ gap: theme.space["12"] }}>
        <LiveActivity
          testID="clock-live"
          label={label}
          elapsed={formatElapsed(workedMs(clock.snapshot, clock.now))}
          place={geofenceText}
          nextShift={clock.shift?.job_title ?? t("compass.clock.live.shift")}
          nextTime={
            clock.shift
              ? t("compass.clock.live.ends", {
                  time: formatTime(clock.shift.ends_at, clock.shift.time_zone),
                })
              : ""
          }
          onBreak={clock.snapshot.state === "break"}
          labels={{
            break: t("compass.clock.startBreak"),
            endBreak: t("compass.clock.endBreak"),
            clockOut: t("compass.clock.out"),
          }}
          onToggleBreak={() =>
            void run(clock.snapshot.state === "break" ? "Break End" : "Break Start")
          }
          onClockOut={() => void run("Out")}
        />
        {clock.forgotten ? (
          <InlineAlert tone="warning" message={t("compass.clock.forgotten")} />
        ) : null}
        {notice ? <InlineAlert testID="clock-notice" tone="info" message={notice} /> : null}
      </View>
    );
  }
  return (
    <View style={{ gap: theme.space["12"] }}>
      <ClockButton
        testID="clock-button"
        state={refusal && clock.snapshot.state === "out" ? "blocked" : clock.snapshot.state}
        label={clock.snapshot.state === "out" ? label : `${label} · ${t(PUNCH_LABEL[primary])}`}
        {...(clock.snapshot.state !== "out"
          ? { timer: formatElapsed(workedMs(clock.snapshot, clock.now)) }
          : {})}
        {...(refusal && clock.snapshot.state === "out" ? { detail: t(REFUSAL_KEY[refusal]) } : {})}
        geofence={geofenceText}
        geofenceOk={clock.geofence.kind === "inside" || clock.geofence.kind === "unfenced"}
        haptics={settings.haptics}
        onPress={() => void run(primary)}
      />
      {secondaryPunches(clock.snapshot.state).map((kind) => (
        <Button
          key={kind}
          testID={`punch-${kind.replace(" ", "-").toLowerCase()}`}
          variant="secondary"
          size="lg"
          block
          label={t(PUNCH_LABEL[kind])}
          onPress={() => void run(kind)}
        />
      ))}
      {clock.forgotten ? (
        <InlineAlert tone="warning" message={t("compass.clock.forgotten")} />
      ) : null}
      {notice ? <InlineAlert testID="clock-notice" tone="info" message={notice} /> : null}
    </View>
  );
}

interface ShiftRow extends Row {
  readonly project_id: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly time_zone?: string;
  readonly job_title?: string | null;
  readonly role_code?: string | null;
  readonly shift_state?: string;
}

function NextCue({ projectId }: { readonly projectId: string }): ReactElement | null {
  const { t } = useTranslation();
  const { rows: cues } = useRows<Cue & Row & { project_id?: string }>(
    "cues",
    (c) => c.project_id === projectId,
  );
  if (cues.length === 0) return null;
  const s = showState(cues, Date.now());
  if (!s.next) return null;
  return (
    <Card title={t("compass.today.nextCue")}>
      <Text variant="heading20">{s.next.label}</Text>
      {s.msToNext !== null ? <Text tone="accent">{formatCountdown(s.msToNext)}</Text> : null}
    </Card>
  );
}

export default function TodayScreen(): ReactElement {
  const { t } = useTranslation();
  const roleTitle = useRoleTitle();
  const router = useRouter();
  const { resolved, projectId, refresh } = useCompass();
  const [refreshing, setRefreshing] = useState(false);
  const identity = resolved?.identity;
  const { rows: shifts } = useRows<ShiftRow>("shifts", (s) => s.project_id === projectId);
  const { rows: sheets } = useRows<Row & { project_id: string; day: string; body: string }>(
    "day_sheets",
    (d) => d.project_id === projectId,
  );
  if (!identity)
    return (
      <Screen title={t("compass.today.title")}>
        <Text>{t("compass.common.loading")}</Text>
      </Screen>
    );
  const canClock = access(identity, "clock", projectId).allowed;
  const today = new Date().toISOString().slice(0, 10);
  const me = {
    membershipId: identity.membershipId,
    engagementIds: operationalEngagements(identity, null).map((e) => e.id),
  };
  const upcoming = shifts
    .filter((s) => isMine(s, me) && Date.parse(s.ends_at) >= Date.now())
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  const sheet = sheets.find((s) => s.day === today);
  const blocks = todayBlocks(identity.audience).map((b) => b.id);
  return (
    <Screen
      testID="today"
      title={t("compass.today.title")}
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void refresh().finally(() => setRefreshing(false));
      }}
    >
      <ProjectPicker />
      <SyncBanner />
      {canClock && projectId ? <ClockCard /> : null}
      {blocks.some((b) => ["shifts", "engaged-shifts-and-positions", "call-times"].includes(b)) ? (
        upcoming.length > 0 ? (
          upcoming.slice(0, 3).map((s) => (
            <ShiftCard
              key={s.id}
              testID={`shift-${s.id}`}
              state={s.shift_state === "Accepted" ? "active" : "scheduled"}
              stateLabel={t(
                s.shift_state === "Accepted"
                  ? "compass.schedule.accepted"
                  : "compass.schedule.published",
              )}
              role={roleTitle(s)}
              date={formatDay(s.starts_at, s.time_zone)}
              time={t("compass.schedule.timeRange", {
                start: formatTime(s.starts_at, s.time_zone),
                end: formatTime(s.ends_at, s.time_zone),
              })}
              place={t("compass.schedule.noPlace")}
              onPress={() => router.push("/schedule")}
            />
          ))
        ) : (
          <EmptyState
            testID="today-no-shifts"
            icon="calendar"
            sentence={t("compass.today.noShifts")}
            actionLabel={t("compass.today.openSchedule")}
            onAction={() => router.push("/schedule")}
          />
        )
      ) : null}
      {blocks.includes("day-sheet") ? (
        <Card title={t("nav.compass.content.daySheet")}>
          <Text tone={sheet ? "primary" : "secondary"}>
            {sheet ? sheet.body : t("compass.today.noDaySheet")}
          </Text>
        </Card>
      ) : null}
      {projectId &&
      (blocks.includes("run-of-show") ||
        blocks.includes("set-time") ||
        blocks.includes("show-day-schedule")) ? (
        <NextCue projectId={projectId} />
      ) : null}
      {blocks
        .filter(
          (b) =>
            ![
              "shifts",
              "engaged-shifts-and-positions",
              "call-times",
              "day-sheet",
              "run-of-show",
              "set-time",
              "show-day-schedule",
              "tasks",
            ].includes(b),
        )
        .map((b) => (
          <Card
            key={b}
            title={t(
              `nav.compass.content.${b.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())}`,
            )}
          >
            <Text tone="secondary">{t("compass.today.blockEmpty")}</Text>
          </Card>
        ))}
    </Screen>
  );
}
