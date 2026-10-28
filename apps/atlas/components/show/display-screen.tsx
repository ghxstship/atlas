"use client";

import {
  clockText,
  DISPLAY_MODES,
  displayFrame,
  type DisplayMode,
  type PublicCue,
} from "@xos/data/live-links";
import { Button } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

/**
 * A display screen (P1, ADR 0130): a running order on a TV or laptop with no sign-in, in one of
 * three modes. It ticks every second from the database's clock (server_now, corrected for this
 * device's offset), so every screen on a link agrees. An overrun turns the timer red and reads
 * "Over by m:ss", so color is never the only signal, and it stays so until the next cue is called.
 * Keys 1, 2 and 3 switch modes; the screen can pop out to a second window and go fullscreen, holds a
 * screen wake lock where the browser offers one, and announces now and next politely. The server page
 * rereads on every channel ping, which hands this component new cues.
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;

interface WakeLockLike {
  release(): Promise<void>;
}

export function DisplayScreen({
  cues,
  name,
  projectName,
  brandName,
  timeZone,
  defaultMode,
  serverNow,
}: {
  cues: readonly PublicCue[];
  name: string;
  projectName: string;
  brandName: string;
  timeZone: string;
  defaultMode: DisplayMode;
  serverNow: string;
}) {
  const t = useTranslations("show.display") as unknown as Translate;
  const format = useFormatter();
  const [mode, setMode] = useState<DisplayMode>(defaultMode);
  // The database's clock minus this device's, measured after each render the server answered.
  const offset = useRef(0);
  const [now, setNow] = useState(() => Date.parse(serverNow));
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    offset.current = Date.parse(serverNow) - Date.now();
  }, [serverNow]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now() + offset.current), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const index = ["1", "2", "3"].indexOf(event.key);
      const picked = index >= 0 ? DISPLAY_MODES[index] : undefined;
      if (picked) setMode(picked);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Hold the screen awake while the page is visible; the lock drops when it is hidden.
  useEffect(() => {
    let lock: WakeLockLike | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: { request(type: "screen"): Promise<WakeLockLike> };
    };
    const acquire = () => {
      if (document.visibilityState !== "visible" || !nav.wakeLock) return;
      nav.wakeLock.request("screen").then(
        (l) => (lock = l),
        () => undefined,
      );
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const frame = displayFrame(cues, now);
  const time = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { timeStyle: "short", timeZone }) : "";
  const timer =
    frame.remainingSeconds !== null
      ? frame.overrun
        ? t("overBy", { time: clockText(frame.remainingSeconds) })
        : clockText(frame.remainingSeconds)
      : frame.elapsedSeconds !== null
        ? clockText(frame.elapsedSeconds)
        : "";
  const timerClass = frame.overrun ? "text-danger-text" : "text-text-primary";
  const lateness =
    frame.latenessSeconds !== null && frame.latenessSeconds >= 60
      ? t("late", { minutes: Math.floor(frame.latenessSeconds / 60) })
      : frame.current
        ? t("onTime")
        : null;
  const status = frame.complete ? t("complete") : frame.current ? null : t("notStarted");

  return (
    <div className="flex min-h-dvh flex-col gap-24 p-24 motion-safe:transition-colors sm:p-40">
      <header className="flex flex-wrap items-center justify-between gap-12">
        <div className="flex flex-col">
          <span className="text-text-14 text-text-secondary">
            {brandName} · {projectName}
          </span>
          <span className="text-heading-20 font-semibold">{name}</span>
        </div>
        <div className="flex flex-wrap items-center gap-8" role="group" aria-label={t("modeKeys")}>
          {DISPLAY_MODES.map((m, i) => (
            <Button
              key={m}
              type="button"
              size="sm"
              variant={m === mode ? "primary" : "ghost"}
              aria-pressed={m === mode}
              shortcut={String(i + 1)}
              onClick={() => setMode(m)}
            >
              {t(`modes.${m}`)}
            </Button>
          ))}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            icon="ExternalLink"
            onClick={() =>
              window.open(window.location.href, "_blank", "popup,width=1280,height=720,noopener")
            }
          >
            {t("openWindow")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            icon="Maximize2"
            onClick={() => {
              if (document.fullscreenElement) void document.exitFullscreen();
              else void document.documentElement.requestFullscreen?.();
            }}
          >
            {fullscreen ? t("exitFullscreen") : t("fullscreen")}
          </Button>
        </div>
      </header>

      {mode === "Room Clock" ? (
        <section className="flex flex-1 flex-col items-center justify-center gap-24 text-center">
          <p className="m-0 text-text-16 text-text-secondary">{t("localTime")}</p>
          <p className="m-0 font-semibold tabular-nums leading-none text-[clamp(4rem,18vw,14rem)]">
            {format.dateTime(new Date(now), { timeStyle: "medium", timeZone })}
          </p>
          <div aria-live="polite" className="flex flex-col gap-8">
            <p className="m-0 text-heading-24">{frame.current?.label ?? status ?? t("noCue")}</p>
            {timer ? (
              <p
                className={`m-0 font-semibold tabular-nums text-[clamp(2rem,8vw,6rem)] ${timerClass}`}
              >
                {frame.remainingSeconds !== null && !frame.overrun
                  ? t("timeLeft", { time: timer })
                  : timer}
              </p>
            ) : null}
          </div>
        </section>
      ) : mode === "Presenter Timer" ? (
        <section className="flex flex-1 flex-col items-center justify-center gap-16 text-center">
          <p aria-live="polite" className="m-0 text-heading-24 text-text-secondary">
            {frame.current?.label ?? status ?? t("noCue")}
          </p>
          <p
            className={`m-0 font-semibold tabular-nums leading-none text-[clamp(5rem,24vw,18rem)] ${timerClass}`}
          >
            {timer || "0:00"}
          </p>
          {frame.remainingSeconds === null && frame.elapsedSeconds !== null ? (
            <p className="m-0 text-text-16 text-text-secondary">
              {t("countUp", { time: clockText(frame.elapsedSeconds) })}
            </p>
          ) : null}
        </section>
      ) : (
        <section className="grid flex-1 gap-24 lg:grid-cols-2">
          <div aria-live="polite" className="flex flex-col gap-8 rounded-lg bg-bg-surface p-24">
            <p className="m-0 text-label-14 font-medium text-text-secondary uppercase">
              {t("now")}
            </p>
            <p className="m-0 text-heading-32 font-semibold">
              {frame.current?.label ?? status ?? t("noCue")}
            </p>
            {frame.current?.segment ? (
              <p className="m-0 text-text-16 text-text-secondary">{frame.current.segment}</p>
            ) : null}
            {frame.elapsedSeconds !== null ? (
              <p className="m-0 text-text-16 tabular-nums">
                {t("elapsed", { time: clockText(frame.elapsedSeconds) })}
              </p>
            ) : null}
            {frame.remainingSeconds !== null ? (
              <p className={`m-0 text-heading-24 font-semibold tabular-nums ${timerClass}`}>
                {frame.overrun ? timer : t("timeLeft", { time: timer })}
              </p>
            ) : null}
            {lateness ? <p className="m-0 text-text-16">{lateness}</p> : null}
          </div>
          <div aria-live="polite" className="flex flex-col gap-8 rounded-lg bg-bg-surface p-24">
            <p className="m-0 text-label-14 font-medium text-text-secondary uppercase">
              {t("next")}
            </p>
            <p className="m-0 text-heading-32 font-semibold">{frame.next?.label ?? ""}</p>
            {frame.next?.plannedAt ? (
              <p className="m-0 text-text-16 text-text-secondary">
                {t("plannedAt", { time: time(frame.next.plannedAt) })}
              </p>
            ) : null}
            {frame.timeToNextSeconds !== null ? (
              <p className="m-0 text-heading-24 tabular-nums">
                {frame.timeToNextSeconds >= 0
                  ? t("startsIn", { time: clockText(frame.timeToNextSeconds) })
                  : t("lateBy", { time: clockText(frame.timeToNextSeconds) })}
              </p>
            ) : null}
            {frame.upcoming.length > 0 ? (
              <div className="mt-16 flex flex-col gap-4">
                <p className="m-0 text-label-13 font-medium text-text-secondary uppercase">
                  {t("following")}
                </p>
                <ol className="m-0 flex list-none flex-col gap-4 p-0">
                  {frame.upcoming.map((c) => (
                    <li key={c.position} className="flex gap-12 text-text-16">
                      <span className="w-64 shrink-0 tabular-nums text-text-secondary">
                        {time(c.plannedAt)}
                      </span>
                      <span>{c.label}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </div>
        </section>
      )}
    </div>
  );
}
