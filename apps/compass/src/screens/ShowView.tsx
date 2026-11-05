/**
 * Live run of show (Section 4.3 item 9, Section 11.13 Show): cue progression and time to the next cue;
 * show mode is large type, dark, kept awake, with a haptic before each cue. Read-only for audiences that
 * follow the show (client, crew, artist) and for anyone without show.cue.call. A person picks their
 * department once on the device and sees its call for the current and next cue (G-74); a cue whose time is
 * to be confirmed reads TBC and is never counted down (G-40, ADR 0131).
 */
import { CUE_CALL_KINDS, CUE_CALL_SLUGS, type CueCallKind } from "@xos/data/cue-calls";
import type { Row } from "@xos/sync";
import * as Haptics from "expo-haptics";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  buildCallCue,
  countdownAnnouncement,
  countdownParts,
  cueCallLines,
  preCueHapticDue,
  showState,
  type Cue,
  type CueCallRow,
} from "../domain/show";
import { hapticsOn } from "../domain/settings";
import { useCompass, useRows } from "../runtime/CompassProvider";
import {
  announce,
  Button,
  Card,
  EmptyState,
  InlineAlert,
  ProgressBar,
  RunOfShowLive,
  Screen,
  SegmentedControl,
  Tag,
  Text,
  ThemeProvider,
} from "../ui";
import { formatTime, ProjectPicker, SyncBanner, useAllowed } from "./common";

type CueRow = Cue & Row & { project_id?: string | null };
type CallRow = CueCallRow & Row;

const KEEP_AWAKE_TAG = "compass-show-mode";

/** What the live show pulls while it is open, and how often without a realtime change. */
const LIVE_TABLES = ["run_of_show", "cues", "cue_calls"] as const;
const LIVE_PULL_MS = 10_000;

export function ShowView({ readOnly }: { readonly readOnly: boolean }): ReactElement {
  const { t } = useTranslation();
  const {
    projectId,
    enqueue,
    settings,
    updateSettings,
    orgSettings,
    client,
    refreshTables,
    network,
  } = useCompass();
  // Journey 15: followers see cues called in Atlas as they happen. A realtime change on the project's
  // cues pulls them at once; a 10 s pull covers externals (whose cues come through an api_external view)
  // and a dropped channel. On the simulator a called cue stayed "next" until a manual refresh.
  useEffect(() => {
    if (!projectId || !network.isConnected) return undefined;
    const pull = () => void refreshTables(LIVE_TABLES);
    const channel = client
      .channel(`show:${projectId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "app", table: "cues", filter: `project_id=eq.${projectId}` },
        pull,
      )
      .subscribe();
    const timer = setInterval(pull, LIVE_PULL_MS);
    return () => {
      clearInterval(timer);
      void client.removeChannel(channel);
    };
  }, [client, projectId, network.isConnected, refreshTables]);
  const canCall = useAllowed("show.callCue") && !readOnly;
  const [showMode, setShowMode] = useState(false);
  const [now, setNow] = useState(Date.now());
  const { rows: cues } = useRows<CueRow>("cues", (c) => c.project_id === projectId);
  const cueIds = new Set(cues.map((c) => c.id));
  const { rows: calls } = useRows<CallRow>("cue_calls", (c) => cueIds.has(c.cue_id));
  const state = showState(cues, now);
  const department = settings.showDepartment;
  const previous = useRef<number | null>(null);
  // The pre-cue haptic follows the person's me.haptics once resolved, as every Compass haptic does.
  const haptics = hapticsOn(settings.haptics, orgSettings);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    // A cue to be confirmed has no firm time: no pre-cue haptic and no spoken countdown for it.
    if (haptics && preCueHapticDue(previous.current, state.msToNext, state.startTbc)) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
    // The countdown is spoken at set points, never on every tick (A23-009).
    const at = countdownAnnouncement(previous.current, state.msToNext, state.startTbc);
    if (at !== null && state.next) {
      announce(
        at === 0
          ? t("compass.show.countdownGo", { cue: state.next.label })
          : t("compass.show.countdownSoon", { cue: state.next.label, seconds: at }),
      );
    }
    previous.current = state.msToNext;
  }, [state.msToNext, state.next, state.startTbc, haptics, t]);
  useEffect(() => {
    if (!showMode) return undefined;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG);
    };
  }, [showMode]);

  if (cues.length === 0) {
    return (
      <Screen testID="show" title={t("compass.show.title")}>
        <ProjectPicker />
        <EmptyState
          testID="show-empty"
          icon="clapperboard"
          sentence={t("compass.show.empty")}
          actionLabel={t("compass.common.refresh")}
        />
      </Screen>
    );
  }
  const ordered = [...cues].sort((a, b) => a.position - b.position);
  const currentIndex = state.current ? ordered.findIndex((c) => c.id === state.current?.id) : -1;
  const nextIndex = state.next ? ordered.findIndex((c) => c.id === state.next?.id) : -1;
  const departmentName = (k: CueCallKind) => t(`compass.show.departments.${CUE_CALL_SLUGS[k]}`);
  const yourCall = (cue: Cue | null, title: string, testID: string) => {
    if (!cue) return null;
    const lines = cueCallLines(calls, cue.id, department);
    return (
      <Card testID={testID} title={title}>
        {lines.length === 0 ? (
          <Text tone="secondary">
            {department === null
              ? t("compass.show.noCalls")
              : t("compass.show.noCall", { department: departmentName(department) })}
          </Text>
        ) : (
          lines.map((line) => (
            <Text key={line.kind} {...(department === null ? {} : { tone: "accent" as const })}>
              {t("compass.show.callLine", {
                department: departmentName(line.kind),
                instruction: line.instruction,
              })}
            </Text>
          ))
        )}
      </Card>
    );
  };
  const statusLabel = t(`compass.show.${state.status === "complete" ? "complete" : state.status}`);
  const body = (
    <Screen
      testID="show"
      title={readOnly ? t("compass.show.runOfShow") : t("compass.show.title")}
      footer={
        canCall && state.next ? (
          <Button
            testID="call-cue"
            size="lg"
            block
            label={`${t("compass.show.callCue")} · ${state.next.label}`}
            onPress={() => state.next && void enqueue(buildCallCue(state.next, Date.now()))}
          />
        ) : undefined
      }
    >
      {showMode ? null : <ProjectPicker />}
      <SyncBanner />
      <Tag
        testID="show-status"
        label={statusLabel}
        tone={state.status === "late" ? "danger" : "accent"}
      />
      {readOnly ? null : (
        <SegmentedControl
          testID="show-department"
          label={t("compass.show.department")}
          value={department === null ? "all" : CUE_CALL_SLUGS[department]}
          options={[
            { value: "all", label: t("compass.show.allDepartments") },
            ...CUE_CALL_KINDS.map((k) => ({ value: CUE_CALL_SLUGS[k], label: departmentName(k) })),
          ]}
          onChange={(value) =>
            updateSettings({
              showDepartment: CUE_CALL_KINDS.find((k) => CUE_CALL_SLUGS[k] === value) ?? null,
            })
          }
        />
      )}
      <ProgressBar
        label={t("compass.show.progress", { called: state.calledCount, total: state.total })}
        value={state.total === 0 ? 0 : (state.calledCount / state.total) * 100}
      />
      <RunOfShowLive
        testID="run-of-show"
        cues={ordered.map((c) => ({
          number: String(c.position),
          time:
            c.start_tbc && c.planned_at
              ? t("compass.show.tbc")
              : c.planned_at
                ? formatTime(c.planned_at)
                : "",
          title: c.label,
        }))}
        current={currentIndex}
        {...(nextIndex >= 0 ? { next: nextIndex } : {})}
        nextInSeconds={state.msToNext === null ? 0 : Math.round(state.msToNext / 1000)}
        showMode={showMode}
        nextLabel={state.onStandby ? t("compass.show.onStandby") : t("compass.show.nextCue")}
        {...(state.startTbc ? { countdownText: t("compass.show.tbc") } : {})}
        {...(state.next && state.startTbc
          ? { countdownLabel: t("compass.show.countdownTbc", { cue: state.next.label }) }
          : state.next && state.msToNext !== null
            ? { countdownLabel: spokenCountdown(t, state.next.label, state.msToNext) }
            : {})}
      />
      {readOnly
        ? null
        : yourCall(
            state.current,
            t("compass.show.yourCallNow", { cue: state.current?.label ?? "" }),
            "your-call-current",
          )}
      {readOnly
        ? null
        : yourCall(
            state.next,
            t("compass.show.yourCallNext", { cue: state.next?.label ?? "" }),
            "your-call-next",
          )}
      {readOnly ? <InlineAlert message={t("compass.show.readOnly")} /> : null}
      <Button
        testID="show-mode"
        variant="secondary"
        label={t(showMode ? "compass.show.exitShowMode" : "compass.show.showMode")}
        onPress={() => setShowMode(!showMode)}
      />
    </Screen>
  );
  return showMode ? <ThemeProvider preference="dark">{body}</ThemeProvider> : body;
}

/** The countdown as a screen reader says it: "2 min 10 s to Doors", or late for a missed cue. */
function spokenCountdown(t: TFunction, cue: string, ms: number): string {
  const { late, minutes, seconds } = countdownParts(ms);
  return t(late ? "compass.show.countdownLate" : "compass.show.countdownLabel", {
    cue,
    minutes,
    seconds,
  });
}
