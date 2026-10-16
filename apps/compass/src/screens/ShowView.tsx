/**
 * Live run of show (Section 4.3 item 9, Section 11.13 Show): cue progression and time to the next cue;
 * show mode is large type, dark, kept awake, with a haptic before each cue. Read-only for audiences that
 * follow the show (client, crew, artist) and for anyone without show.cue.call.
 */
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
  preCueHapticDue,
  showState,
  type Cue,
} from "../domain/show";
import { useCompass, useRows } from "../runtime/CompassProvider";
import {
  announce,
  Button,
  EmptyState,
  InlineAlert,
  ProgressBar,
  RunOfShowLive,
  Screen,
  Tag,
  ThemeProvider,
} from "../ui";
import { formatTime, ProjectPicker, SyncBanner, useAllowed } from "./common";

type CueRow = Cue & Row & { project_id?: string | null };

const KEEP_AWAKE_TAG = "compass-show-mode";

export function ShowView({ readOnly }: { readonly readOnly: boolean }): ReactElement {
  const { t } = useTranslation();
  const { projectId, enqueue, settings } = useCompass();
  const canCall = useAllowed("show.callCue") && !readOnly;
  const [showMode, setShowMode] = useState(false);
  const [now, setNow] = useState(Date.now());
  const { rows: cues } = useRows<CueRow>("cues", (c) => c.project_id === projectId);
  const state = showState(cues, now);
  const previous = useRef<number | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (settings.haptics && preCueHapticDue(previous.current, state.msToNext)) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
    // The countdown is spoken at set points, never on every tick (A23-009).
    const at = countdownAnnouncement(previous.current, state.msToNext);
    if (at !== null && state.next) {
      announce(
        at === 0
          ? t("compass.show.countdownGo", { cue: state.next.label })
          : t("compass.show.countdownSoon", { cue: state.next.label, seconds: at }),
      );
    }
    previous.current = state.msToNext;
  }, [state.msToNext, state.next, settings.haptics, t]);
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
      <ProgressBar
        label={t("compass.show.progress", { called: state.calledCount, total: state.total })}
        value={state.total === 0 ? 0 : (state.calledCount / state.total) * 100}
      />
      <RunOfShowLive
        testID="run-of-show"
        cues={ordered.map((c) => ({
          number: String(c.position),
          time: c.planned_at ? formatTime(c.planned_at) : "",
          title: c.label,
        }))}
        current={currentIndex}
        nextInSeconds={state.msToNext === null ? 0 : Math.round(state.msToNext / 1000)}
        showMode={showMode}
        nextLabel={t("compass.show.nextCue")}
        {...(state.next && state.msToNext !== null
          ? { countdownLabel: spokenCountdown(t, state.next.label, state.msToNext) }
          : {})}
      />
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
