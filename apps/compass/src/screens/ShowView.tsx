/**
 * Live run of show (Section 4.3 item 9, Section 11.13 Show): cue progression and time to the next cue;
 * show mode is large type, dark, kept awake, with a haptic before each cue. Read-only for audiences that
 * follow the show (the Client) and for anyone without show.cue.call. A person picks their
 * department once on the device and sees its call for the current and next cue (G-74); a cue whose time is
 * to be confirmed reads TBC and is never counted down (G-40, ADR 0131).
 */
import { CUE_CALL_KINDS, CUE_CALL_SLUGS, type CueCallKind } from "@xos/data/cue-calls";
import type { Row } from "@xos/sync";
import * as Haptics from "expo-haptics";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { type ReactElement, useEffect, useId, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  buildCallCue,
  countdownAnnouncement,
  countdownDisplay,
  countdownParts,
  cueCallLines,
  liveRunningOrder,
  preCueHapticDue,
  runningOrders,
  showState,
  type Cue,
  type CueCallRow,
  type RunningOrder,
  type RunningOrderRow,
} from "../domain/show";
import { formatCalendarDay } from "../domain/dates";
import { hapticsOn } from "../domain/settings";
import { useCompass, useRows } from "../runtime/CompassProvider";
import {
  announce,
  Button,
  Card,
  EmptyState,
  InlineAlert,
  ListRow,
  ProgressBar,
  RunOfShowLive,
  Screen,
  SegmentedControl,
  Sheet,
  Tag,
  Text,
  ThemeProvider,
} from "../ui";
import { formatDay, formatTime, ProjectPicker, SyncBanner, useAllowed } from "./common";

type CueRow = Cue & Row & { project_id?: string | null };
type CallRow = CueCallRow & Row;
type OrderRow = RunningOrderRow & Row & { project_id?: string | null };

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
  // Run of Show and Show both render this view, and Show opens over Run of Show. The realtime client returns the
  // already subscribed channel for a repeated name, and adding a listener to it throws, which crashed Compass; each
  // mounted view takes its own channel name.
  const instance = useId();
  useEffect(() => {
    if (!projectId || !network.isConnected) return undefined;
    const pull = () => void refreshTables(LIVE_TABLES);
    const channel = client
      .channel(`show:${projectId}:${instance}`)
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
  }, [client, projectId, network.isConnected, refreshTables, instance]);
  const canCall = useAllowed("show.callCue") && !readOnly;
  const [showMode, setShowMode] = useState(false);
  const [now, setNow] = useState(Date.now());
  const { rows: cues } = useRows<CueRow>("cues", (c) => c.project_id === projectId);
  const { rows: orderRows } = useRows<OrderRow>("run_of_show", (r) => r.project_id === projectId);
  // Each running order reads on its own (C-08): the one the person picked, else the live one.
  const [chosenOrder, setChosenOrder] = useState<string | null>(null);
  const orders = runningOrders(cues, orderRows);
  const order = orders.find((o) => o.id === chosenOrder) ?? liveRunningOrder(orders, now);
  const ordered = order?.cues ?? [];
  const cueIds = new Set(ordered.map((c) => c.id));
  const { rows: calls } = useRows<CallRow>("cue_calls", (c) => cueIds.has(c.cue_id));
  const state = showState(ordered, now);
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
      <Screen
        testID="show"
        title={readOnly ? t("compass.show.runOfShow") : t("compass.show.title")}
      >
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
  // Past the 12-hour horizon the countdown names the cue's day and time, as Today does (C-09).
  const display = countdownDisplay(state);
  const planned =
    display.kind === "planned"
      ? { day: formatDay(display.at), time: formatTime(display.at) }
      : null;
  const today = formatDay(new Date(now).toISOString());
  const cueTime = (at: string) =>
    formatDay(at) === today ? formatTime(at) : `${formatDay(at)} ${formatTime(at)}`;
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
      {showMode || orders.length < 2 || !order ? null : (
        <RunningOrderPicker orders={orders} current={order} onChoose={setChosenOrder} />
      )}
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
                ? cueTime(c.planned_at)
                : "",
          title: c.label,
        }))}
        current={currentIndex}
        {...(nextIndex >= 0 ? { next: nextIndex } : {})}
        nextInSeconds={state.msToNext === null ? 0 : Math.round(state.msToNext / 1000)}
        showMode={showMode}
        nextLabel={state.onStandby ? t("compass.show.onStandby") : t("compass.show.nextCue")}
        {...(display.kind === "tbc"
          ? { countdownText: t("compass.show.tbc") }
          : planned
            ? { countdownText: t("compass.today.nextCueAt", planned) }
            : {})}
        {...(state.next && display.kind === "tbc"
          ? { countdownLabel: t("compass.show.countdownTbc", { cue: state.next.label }) }
          : state.next && planned
            ? {
                countdownLabel: t("compass.show.countdownPlanned", {
                  cue: state.next.label,
                  ...planned,
                }),
              }
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

/** The running order's name and show day, as the picker reads it. */
function orderLabel(t: TFunction, order: RunningOrder): string {
  const name = order.name || t("compass.show.runningOrderUnnamed");
  return order.showDate ? `${name} · ${formatCalendarDay(order.showDate)}` : name;
}

/** A project with several running orders (a side stage, another show day) picks one; each reads on its own. */
function RunningOrderPicker({
  orders,
  current,
  onChoose,
}: {
  readonly orders: readonly RunningOrder[];
  readonly current: RunningOrder;
  readonly onChoose: (id: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        testID="running-order-picker"
        variant="secondary"
        icon="list"
        label={orderLabel(t, current)}
        onPress={() => setOpen(true)}
      />
      <Sheet
        open={open}
        title={t("compass.show.runningOrders")}
        closeLabel={t("compass.common.close")}
        onClose={() => setOpen(false)}
      >
        {orders.map((o) => (
          <ListRow
            key={o.id}
            testID={`running-order-${o.id}`}
            title={orderLabel(t, o)}
            icon={o.id === current.id ? "check" : "list"}
            onPress={() => {
              onChoose(o.id);
              setOpen(false);
            }}
          />
        ))}
      </Sheet>
    </>
  );
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
