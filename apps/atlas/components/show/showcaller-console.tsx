"use client";

import {
  callLines,
  CUE_CALL_KINDS,
  CUE_CALL_SLUGS,
  type Cue,
  type CueCall,
  type CueCallKind,
  type RunOfShow,
} from "@xos/data/show";
import { cueProgress, showClock } from "@xos/data/show-timing";
import { chordOf, type Platform } from "@xos/schemas/shortcuts/keys";
import { Button, Dialog, Input, RunOfShowLive, Select, Tag } from "@xos/ui";
import { singleKeyShortcutsEnabled } from "@xos/ui/preferences";
import { useLocale } from "next-intl";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useShellKeys } from "@/components/shell/shell-keys-context";
import type { ActionResult } from "@/components/work/action-result";
import { ActionErrorAlert, useAction, useCopy } from "@/components/work/action-ui";
import { formatScheduleTime, formatStartTime } from "@/components/work/format";
import { useScheduleView } from "@/components/work/use-schedule-view";
import { callCueAction, shiftCuePlanAction, standbyCueAction } from "./actions";
import { showKeyAction, stepTarget, type ShowAction } from "./show-keys";

/**
 * The showcaller console (G-75, G-77, ADR 0131): live mode for a person who calls cues. runs.tsx loads
 * it with next/dynamic. It ticks every second and reads @xos/data/show-timing, the rules Compass uses:
 * the show clock, time of day in the run's zone, overrun against the plan, the projected end against
 * the curfew, and the current and standby cues with their department calls.
 *
 * Go calls the selected cue: the one the person picked with Previous, Next or Jump to cue, else the
 * standby cue, else the next cue. Standby puts the selection on standby, which followers see through
 * Realtime. Keys come from the shortcut registry's show scope while focus is in the console; letters
 * and symbols obey me.shortcuts_enabled, and the Stream Deck's F13 to F20 always answer (WCAG 2.1.4
 * covers character keys only). RunOfShowLive keeps Space, so one press makes one call. The per-second
 * clock, time of day and countdown sit outside any live region (A23-009); RunBody's status lines
 * announce the current and standby cue once per change.
 */

/**
 * How the console writes (B3, ADR 0142): signed in, the show actions under the person's own access; on a
 * showcaller link's portal, the portal's actions under the link's token and device grant. The console decides
 * nothing the database does not check again.
 */
export interface ShowcallerTransport {
  call(cueId: string): Promise<ActionResult<unknown>>;
  standby(cueId: string | null): Promise<ActionResult<unknown>>;
  nudge(seconds: number): Promise<ActionResult<unknown>>;
}

/** The signed-in console's writes: app.call_cue, app.standby_cue and app.shift_cue_plan through the show actions. */
export function signedInTransport(org: string, runId: string): ShowcallerTransport {
  return {
    call: (cueId) => callCueAction(org, cueId),
    standby: (cueId) => standbyCueAction(org, runId, cueId),
    nudge: (seconds) => shiftCuePlanAction(org, runId, seconds),
  };
}

/**
 * The console action a key press makes, or null. Keys pressed in a field (the show channel's message box among
 * them), outside the console (an open dialog is portaled away; the show channel sits beside it), while composing,
 * repeated, or while Jump to cue is open make none; the rest follow showKeyAction.
 */
export function consoleKeyAction(press: {
  readonly defaultPrevented: boolean;
  readonly composing: boolean;
  readonly repeat: boolean;
  readonly jumping: boolean;
  readonly inside: boolean;
  readonly typing: boolean;
  readonly chord: string | null;
  readonly scoped: Readonly<Record<string, string>>;
  readonly singleKeys: boolean;
}): ShowAction | null {
  if (press.defaultPrevented || press.composing || press.repeat || press.jumping) return null;
  if (!press.inside || press.typing || press.chord === null) return null;
  return showKeyAction(press.chord, press.scoped, press.singleKeys);
}

/** Seconds as m:ss, or h:mm:ss past an hour. */
function clock(total: number): string {
  const s = Math.abs(Math.round(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-text-12 text-text-secondary">{label}</span>
      <span className="text-heading-20 font-semibold tabular-nums">{children}</span>
    </div>
  );
}

export function ShowcallerConsole({
  org,
  run,
  cues,
  calls,
  department,
  onDepartment,
  transport,
  shortcuts,
  onChat,
}: {
  org: string;
  run: RunOfShow;
  /** The running order's live cues in position order. */
  cues: readonly Cue[];
  calls: readonly CueCall[];
  department: CueCallKind | null;
  onDepartment: (kind: CueCallKind | null) => void;
  /** Where writes go; the signed-in show actions by default. */
  transport?: ShowcallerTransport;
  /**
   * The show-scope keys outside the Atlas shell (the showcaller portal), by registry id; inside the shell the
   * person's own bindings come from useShellKeys.
   */
  shortcuts?: { readonly platform: Platform; readonly scoped: Readonly<Record<string, string>> };
  /**
   * show.chat (M): moves focus to the show channel's message box beside the console. Without it (the portal has no
   * channel) the key is left alone.
   */
  onChat?: () => void;
}) {
  const t = useCopy("show");
  const locale = useLocale();
  const view = useScheduleView();
  const shellKeys = useShellKeys();
  const keys = shortcuts ?? shellKeys;
  const writes = transport ?? signedInTransport(org, run.id);
  const action = useAction();
  const region = useRef<HTMLElement>(null);
  const [now, setNow] = useState(() => new Date());
  const [picked, setPicked] = useState<string | null>(null);
  const [jumping, setJumping] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  // Live mode opens with the console focused, so its keys answer at once.
  useEffect(() => {
    region.current?.focus();
  }, []);

  const progress = cueProgress(cues, now);
  const timing = showClock(cues, run, now);
  const zone = run.timeZone;
  const pickedIndex = cues.findIndex((c) => c.id === picked && c.calledAt === null);
  const selected = pickedIndex >= 0 ? pickedIndex : progress.next;
  const selectedCue = selected >= 0 ? cues[selected] : undefined;
  const current = progress.current >= 0 ? cues[progress.current] : undefined;
  const upcoming = progress.next >= 0 ? cues[progress.next] : undefined;
  const uncalled = cues.flatMap((c, i) => (c.calledAt === null ? [i] : []));
  const time = (c: Cue) =>
    formatStartTime(c.plannedAt, c.startTbc, locale, zone, view, "time", (at) =>
      t("cues.tbcEstimate", { time: at }),
    ) ?? "";
  const label = (k: CueCallKind) => t(`cues.departments.${CUE_CALL_SLUGS[k]}`);

  const go = () => {
    const cue = selectedCue;
    if (!cue || cue.calledAt) return;
    action.run(
      () => writes.call(cue.id),
      () => setPicked(null),
    );
  };
  const standby = (cue: Cue | undefined) => {
    if (!cue || cue.calledAt) return;
    setPicked(cue.id);
    action.run(() => writes.standby(cue.id));
  };
  const step = (direction: -1 | 1) => {
    const to = stepTarget(cues, { ...progress, picked: pickedIndex }, direction);
    if (to !== undefined) standby(cues[to]);
  };
  const nudge = (seconds: number) => action.run(() => writes.nudge(seconds));
  const cycleDepartment = () => {
    const at = department === null ? -1 : CUE_CALL_KINDS.indexOf(department);
    onDepartment(at + 1 < CUE_CALL_KINDS.length ? (CUE_CALL_KINDS[at + 1] ?? null) : null);
  };
  const perform = (what: ShowAction) => {
    switch (what) {
      case "go":
        return go();
      case "standby":
        return standby(selectedCue);
      case "previous":
        return step(-1);
      case "next":
        return step(1);
      case "jump":
        return setJumping(true);
      case "nudge-later":
        return nudge(60);
      case "nudge-earlier":
        return nudge(-60);
      case "department":
        return cycleDepartment();
      case "chat":
        return onChat?.();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const inside = event.target instanceof Node && event.currentTarget.contains(event.target);
    const what = consoleKeyAction({
      defaultPrevented: event.defaultPrevented,
      composing: event.nativeEvent.isComposing,
      repeat: event.repeat,
      jumping,
      inside,
      typing: typing(event.target),
      chord: chordOf(event.nativeEvent, keys.platform),
      scoped: keys.scoped,
      singleKeys: singleKeyShortcutsEnabled(),
    });
    if (what === null || (what === "chat" && !onChat)) return;
    event.preventDefault();
    perform(what);
  };

  const lines = (cue: Cue | undefined) => {
    if (!cue) return null;
    const own = calls.filter((c) => c.cueId === cue.id);
    const shown = callLines(own, department);
    if (department !== null && shown.length === 0) {
      return (
        <p className="m-0 text-text-13 text-text-secondary">
          {t("cues.noCall", { department: label(department) })}
        </p>
      );
    }
    return (
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {shown.map((line) => (
          <li
            key={line.kind}
            className={
              department === null ? "text-text-13" : "text-text-14 font-semibold text-accent-text"
            }
          >
            {t("cues.callLine", { department: label(line.kind), instruction: line.instruction })}
          </li>
        ))}
      </ul>
    );
  };

  const plan =
    timing.overrunSeconds === null
      ? t("console.noPlan")
      : timing.overrunSeconds > 0
        ? t("console.behind", { time: clock(timing.overrunSeconds) })
        : timing.overrunSeconds < 0
          ? t("console.ahead", { time: clock(timing.overrunSeconds) })
          : t("console.onTime");
  const curfewTone = { none: "neutral", ok: "success", near: "warning", over: "danger" } as const;
  const curfewText = {
    none: "",
    ok: t("console.curfewOk"),
    near: t("console.curfewNear"),
    over: t("console.curfewOver"),
  };
  const matches = uncalled.filter((i) =>
    `${cues[i]?.position ?? ""} ${cues[i]?.label ?? ""}`
      .toLowerCase()
      .includes(filter.trim().toLowerCase()),
  );

  return (
    <section
      ref={region}
      tabIndex={-1}
      aria-label={t("console.label")}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-16 rounded-card"
    >
      <div className="grid grid-cols-4 gap-12 max-sm:grid-cols-2">
        <Stat label={t("console.clock")}>
          {timing.elapsedSeconds === null ? t("console.notStarted") : clock(timing.elapsedSeconds)}
        </Stat>
        <Stat label={t("console.timeOfDay")}>
          {new Intl.DateTimeFormat(locale, { timeStyle: "medium", timeZone: zone }).format(now)}
        </Stat>
        <Stat label={t("console.plan")}>
          <span
            data-testid="console-overrun"
            className={
              timing.overrunSeconds !== null && timing.overrunSeconds > 0 ? "text-warning-text" : ""
            }
          >
            {plan}
          </span>
        </Stat>
        {run.curfewAt && timing.projectedEndAt ? (
          <Stat label={t("console.curfew")}>
            <span className="flex flex-col items-start gap-4" data-testid="console-curfew">
              <span className="text-text-14">
                {t("console.projected", {
                  end: formatScheduleTime(timing.projectedEndAt, locale, zone, view, "time") ?? "",
                  curfew: formatScheduleTime(run.curfewAt, locale, zone, view, "time") ?? "",
                })}
              </span>
              <Tag tone={curfewTone[timing.curfewRisk]}>{curfewText[timing.curfewRisk]}</Tag>
            </span>
          </Stat>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-12 max-sm:grid-cols-1">
        <div className="flex flex-col gap-4 rounded-card border border-border-subtle p-12">
          <span className="text-text-12 text-text-secondary">{t("console.current")}</span>
          <strong className="text-heading-16">{current ? current.label : t("console.none")}</strong>
          {lines(current)}
        </div>
        <div className="flex flex-col gap-4 rounded-card border border-border-subtle p-12">
          <span className="text-text-12 text-text-secondary">
            {progress.standby ? t("console.standby") : t("console.next")}
          </span>
          <strong className="text-heading-16">
            {upcoming ? `${upcoming.label} · ${time(upcoming)}` : t("console.none")}
          </strong>
          {lines(upcoming)}
          {selectedCue && selectedCue !== upcoming ? (
            <span className="text-text-13">
              {t("console.selected")}: {selectedCue.label}
            </span>
          ) : null}
        </div>
      </div>

      <ActionErrorAlert error={action.error} />
      <div className="flex flex-wrap items-end gap-8">
        {/* Journey 15: the standby cue, else the next cue, whatever is selected. */}
        <Button
          variant="primary"
          loading={action.pending}
          disabled={!upcoming}
          onClick={() => {
            if (upcoming)
              action.run(
                () => writes.call(upcoming.id),
                () => setPicked(null),
              );
          }}
        >
          {t("live.callNext")}
        </Button>
        <Button
          icon="Play"
          data-shortcut="show.go"
          loading={action.pending}
          disabled={!selectedCue}
          aria-label={selectedCue ? t("console.goLabel", { label: selectedCue.label }) : undefined}
          onClick={go}
        >
          {t("console.go")}
        </Button>
        <Button
          data-shortcut="show.standby"
          disabled={!selectedCue}
          aria-label={
            selectedCue ? t("console.standbyLabel", { label: selectedCue.label }) : undefined
          }
          onClick={() => standby(selectedCue)}
        >
          {t("console.standbyAction")}
        </Button>
        <Button icon="ArrowUp" data-shortcut="show.previous" onClick={() => step(-1)}>
          {t("console.previous")}
        </Button>
        <Button icon="ArrowDown" data-shortcut="show.next" onClick={() => step(1)}>
          {t("console.nextCue")}
        </Button>
        <Button icon="ListOrdered" data-shortcut="show.jump" onClick={() => setJumping(true)}>
          {t("console.jump")}
        </Button>
        <Button
          data-shortcut="show.nudge-earlier"
          title={t("console.nudgeEarlierLabel")}
          onClick={() => nudge(-60)}
        >
          {t("console.nudgeEarlier")}
        </Button>
        <Button
          data-shortcut="show.nudge-later"
          title={t("console.nudgeLaterLabel")}
          onClick={() => nudge(60)}
        >
          {t("console.nudgeLater")}
        </Button>
        <Select
          id={`console-department-${run.id}`}
          label={t("cues.department")}
          data-shortcut="show.department"
          value={department === null ? "" : CUE_CALL_SLUGS[department]}
          options={[
            { value: "", label: t("cues.allDepartments") },
            ...CUE_CALL_KINDS.map((k) => ({ value: CUE_CALL_SLUGS[k], label: label(k) })),
          ]}
          onChange={(e) =>
            onDepartment(CUE_CALL_KINDS.find((k) => CUE_CALL_SLUGS[k] === e.target.value) ?? null)
          }
        />
      </div>
      <p className="m-0 text-text-12 text-text-secondary">{t("console.keys")}</p>

      <RunOfShowLive
        key={`${progress.current}:${selected}`}
        cues={cues.map((c, i) => ({
          number: String(c.position),
          time: time(c),
          title: c.label,
          ...(c.durationSeconds !== null ? { durationSeconds: c.durationSeconds } : {}),
          ...(progress.skipped.includes(i)
            ? { status: "skipped" as const }
            : c.calledAt === null && c.standbyAt
              ? { status: "standby" as const }
              : {}),
        }))}
        current={progress.current}
        nextInSeconds={progress.nextInSeconds ?? 0}
        showMode
        // Go ignores the index RunOfShowLive steps to and calls the selected cue.
        onGo={() => go()}
      />

      {jumping ? (
        <Dialog
          title={t("console.jump")}
          description={t("console.jumpBody")}
          open
          onOpenChange={(v) => (v ? undefined : setJumping(false))}
          actions={
            <Button variant="ghost" onClick={() => setJumping(false)}>
              {t("console.cancel")}
            </Button>
          }
        >
          <Input
            id={`console-jump-${run.id}`}
            type="search"
            label={t("console.jumpFilter")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {matches.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("console.jumpEmpty")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-4 p-0">
              {matches.map((i) => {
                const cue = cues[i];
                if (!cue) return null;
                return (
                  <li key={cue.id}>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setJumping(false);
                        setFilter("");
                        standby(cue);
                      }}
                    >
                      {t("console.jumpOption", { n: cue.position, label: cue.label })}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Dialog>
      ) : null}
    </section>
  );
}
