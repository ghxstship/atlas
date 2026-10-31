import type { Row } from "@xos/sync";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { access, operationalEngagements, todayBlocks } from "../../src/domain/access";
import { currentShift, isMine } from "../../src/domain/shifts";
import {
  formatElapsed,
  needsPreciseFix,
  primaryPunch,
  secondaryPunches,
  workedMs,
  type ClockSnapshot,
  type PunchKind,
  type PunchRefusal,
} from "../../src/domain/clock";
import { formatCountdown, showState, showsCountdown, type Cue } from "../../src/domain/show";
import { todayIn } from "@xos/data/calendar";
import { punchAnnouncementKey } from "../../src/domain/announce";
import { ongoingContent, type Translate } from "../../src/domain/glance";
import { itemZone } from "../../src/domain/orgs";
import { useHomeWidgets, useOngoingNotification } from "../../src/runtime/glance";
import { CombinedToday } from "../../src/screens/CombinedToday";
import { TodaySearch } from "../../src/screens/TodaySearch";
import { useTodayGlance, type TodayGlance } from "../../src/screens/useTodayGlance";
import { formatDistance, hapticsOn, scheduleZone } from "../../src/domain/settings";
import { useCompass, useRows } from "../../src/runtime/CompassProvider";
import { useClockLiveActivity, useLockScreenPunchDrain } from "../../src/runtime/liveActivity";
import {
  formatDay,
  formatTime,
  ProjectPicker,
  StorageResetNotice,
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

/** The shift being worked as the On Shift card names it: role, times and place. */
interface WorkingShift {
  readonly title: string;
  readonly time: string;
  readonly place: string;
}

function ClockCard({
  current,
  onState,
  glance,
  zone,
}: {
  readonly current: WorkingShift | null;
  /** Tells Today the clock state, so the worked shift's card can read On Shift. */
  readonly onState: (state: "out" | "on" | "break") => void;
  /** Today at a glance: the next cue for the Live Activity and the Android ongoing notification. */
  readonly glance: TodayGlance;
  /** The project's time zone, for the times the notification names. */
  readonly zone: string;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { settings, status, resolved, projectId, enqueue, engine, orgSettings } = useCompass();
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
  useEffect(() => {
    setClockedOut(clock.snapshot.state === "out");
    onState(clock.snapshot.state);
  }, [clock.snapshot.state, onState]);
  // The iOS Live Activity mirrors this clock on the lock screen and in the Dynamic Island (SIM-005); punches
  // made there arrive through the drain into the same outbox.
  const projectName = resolved?.projects.find((p) => p.id === projectId)?.name ?? "";
  const lockScreenFailure = useClockLiveActivity(
    clock.snapshot,
    clock.context,
    {
      projectName,
      onShift: t("compass.clock.onShift"),
      onBreak: t("compass.clock.onBreak"),
      since: t("compass.clock.live.since"),
      worked: t("compass.clock.live.worked"),
      startBreak: t("compass.clock.startBreak"),
      endBreak: t("compass.clock.endBreak"),
      clockOut: t("compass.clock.out"),
      nextCue: t("compass.today.nextCue"),
    },
    // The Clock In App Shortcut's replies (Siri reads them aloud).
    {
      clockedIn: t("compass.clock.shortcut.clockedIn", { project: projectName }),
      alreadyIn: t("compass.clock.refusal.alreadyIn"),
    },
    glance.cue,
  );
  // Android: the running shift and the next cue as an ongoing notification (A65-011 part 4).
  useOngoingNotification(
    ongoingContent(
      clock.snapshot,
      glance.cue,
      projectName,
      clock.now,
      t as Translate,
      formatTime,
      zone,
    ),
    t("compass.glance.channel"),
    glance.link,
  );
  const drainProblem = useLockScreenPunchDrain(engine ? enqueue : null);
  const lockScreenNotice = lockScreenFailure
    ? t("compass.clock.live.lockScreenFailed", { reason: lockScreenFailure })
    : drainProblem?.error
      ? t("compass.clock.live.drainFailed", { reason: drainProblem.error })
      : drainProblem && drainProblem.dropped > 0
        ? t("compass.clock.live.drainDropped", { count: drainProblem.dropped })
        : null;
  const primary = primaryPunch(clock.snapshot.state);
  const refusal = clock.refusal(primary);
  const geofenceText = (() => {
    const g = clock.geofence;
    if (clock.locationDenied) return t("compass.clock.locationOff");
    if (g.kind === "inside") return t("compass.clock.inside", { name: g.geofence.name });
    if (g.kind === "outside")
      return g.nearest && g.distanceM !== null && g.distanceM < 5000
        ? t("compass.clock.outside", {
            distance: formatDistance(i18n.language, g.distanceM, orgSettings),
            name: g.nearest.name,
          })
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
          nextShift={current?.title ?? ""}
          nextTime={current?.time ?? ""}
          {...(current ? { nextPlace: current.place } : {})}
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
        {lockScreenNotice ? (
          <InlineAlert testID="clock-lock-screen" tone="warning" message={lockScreenNotice} />
        ) : null}
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
        haptics={hapticsOn(settings.haptics, orgSettings)}
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
      {lockScreenNotice ? (
        <InlineAlert testID="clock-lock-screen" tone="warning" message={lockScreenNotice} />
      ) : null}
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
      {showsCountdown(s.msToNext) ? (
        <Text tone="accent">{formatCountdown(s.msToNext)}</Text>
      ) : s.next.planned_at ? (
        <Text tone="secondary">
          {t("compass.today.nextCueAt", {
            day: formatDay(s.next.planned_at),
            time: formatTime(s.next.planned_at),
          })}
        </Text>
      ) : null}
    </Card>
  );
}

const CLOCKED_OUT: ClockSnapshot = {
  state: "out",
  onSince: null,
  breakSince: null,
  breakMs: 0,
  projectId: null,
  shiftId: null,
};

/**
 * For a person who does not clock in here (a Client following the show, say): the next cue alone, on the
 * Lock Screen and in the Dynamic Island (iOS) or as an ongoing notification (Android), once it is close.
 */
function CueGlance({ glance }: { readonly glance: TodayGlance }): null {
  const { t } = useTranslation();
  const labels = {
    projectName: glance.cue?.project ?? "",
    onShift: t("compass.clock.onShift"),
    onBreak: t("compass.clock.onBreak"),
    since: t("compass.clock.live.since"),
    worked: t("compass.clock.live.worked"),
    startBreak: t("compass.clock.startBreak"),
    endBreak: t("compass.clock.endBreak"),
    clockOut: t("compass.clock.out"),
    nextCue: t("compass.today.nextCue"),
  };
  useClockLiveActivity(CLOCKED_OUT, null, labels, { clockedIn: "", alreadyIn: "" }, glance.cue);
  useOngoingNotification(
    ongoingContent(
      CLOCKED_OUT,
      glance.cue,
      "",
      Date.now(),
      t as Translate,
      formatTime,
      glance.cue?.zone ?? "UTC",
    ),
    t("compass.glance.channel"),
    glance.link,
  );
  return null;
}

export default function TodayScreen(): ReactElement {
  const { t } = useTranslation();
  const roleTitle = useRoleTitle();
  const router = useRouter();
  const { resolved, projectId, refresh, personZone, orgSettings } = useCompass();
  const [refreshing, setRefreshing] = useState(false);
  const [clockState, setClockState] = useState<"out" | "on" | "break">("out");
  const identity = resolved?.identity;
  const { rows: shifts } = useRows<ShiftRow>("shifts", (s) => s.project_id === projectId);
  const { rows: sheets } = useRows<Row & { project_id: string; day: string; body: string }>(
    "day_sheets",
    (d) => d.project_id === projectId,
  );
  const { rows: projectRows } = useRows<Row & { time_zone?: string | null }>(
    "projects",
    (p) => p.id === projectId,
  );
  // Today's shifts and next cue for the home screen widgets, the Live Activity and the ongoing notification.
  const glance = useTodayGlance();
  useHomeWidgets(glance.widget);
  if (!identity)
    return (
      <Screen title={t("compass.today.title")}>
        <Text>{t("compass.common.loading")}</Text>
      </Screen>
    );
  const canClock = access(identity, "clock", projectId).allowed;
  // Today on the project's calendar (A71), never the UTC date, which is tomorrow every evening in the Americas.
  const zone = itemZone(null, projectRows[0]?.time_zone, personZone);
  const today = todayIn(zone);
  // A person in several orgs sees every org's day, grouped with brand chips (Section 4.5.7).
  const combined = (resolved?.contexts.length ?? 0) > 1;
  const me = {
    membershipId: identity.membershipId,
    engagementIds: operationalEngagements(identity, null).map((e) => e.id),
  };
  const upcoming = shifts
    .filter((s) => isMine(s, me) && Date.parse(s.ends_at) >= Date.now())
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  const sheet = sheets.find((s) => s.day === today);
  // The shift being worked: named on the On Shift card, and read On Shift (not Waiting for you) below.
  const working = currentShift(upcoming, Date.now());
  const workingCard = working
    ? {
        title: roleTitle(working),
        time: t("compass.schedule.timeRange", {
          start: formatTime(working.starts_at, scheduleZone(working.time_zone, orgSettings)),
          end: formatTime(working.ends_at, scheduleZone(working.time_zone, orgSettings)),
        }),
        place: t("compass.schedule.noPlace"),
      }
    : null;
  const onShiftNow = clockState !== "out";
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
      <TodaySearch />
      <StorageResetNotice />
      <SyncBanner />
      {canClock && projectId ? (
        <ClockCard current={workingCard} onState={setClockState} glance={glance} zone={zone} />
      ) : (
        <CueGlance glance={glance} />
      )}
      {combined ? <CombinedToday clockState={clockState} /> : null}
      {!combined &&
      blocks.some((b) => ["shifts", "engaged-shifts-and-positions", "call-times"].includes(b)) ? (
        upcoming.length > 0 ? (
          upcoming.slice(0, 3).map((s) => (
            <ShiftCard
              key={s.id}
              testID={`shift-${s.id}`}
              state={
                s.shift_state === "Accepted" || (onShiftNow && s.id === working?.id)
                  ? "active"
                  : "scheduled"
              }
              stateLabel={t(
                onShiftNow && s.id === working?.id
                  ? clockState === "break"
                    ? "compass.clock.onBreak"
                    : "compass.clock.onShift"
                  : s.shift_state === "Accepted"
                    ? "compass.schedule.accepted"
                    : "compass.schedule.published",
              )}
              role={roleTitle(s)}
              date={formatDay(s.starts_at, scheduleZone(s.time_zone, orgSettings))}
              time={t("compass.schedule.timeRange", {
                start: formatTime(s.starts_at, scheduleZone(s.time_zone, orgSettings)),
                end: formatTime(s.ends_at, scheduleZone(s.time_zone, orgSettings)),
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
      {!combined && blocks.includes("day-sheet") ? (
        <Card title={t("nav.compass.content.daySheet")}>
          <Text tone={sheet ? "primary" : "secondary"}>
            {sheet ? sheet.body : t("compass.today.noDaySheet")}
          </Text>
        </Card>
      ) : null}
      {!combined &&
      projectId &&
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
