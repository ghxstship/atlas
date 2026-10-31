import { useEffect, useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { formatClock } from "../lib/format.ts";
import { Button } from "../Button/Button.tsx";
import { DepartmentGlyph } from "../Glyphs/Glyphs.tsx";
import { Tag } from "../Chips/Chips.tsx";
import { type RunOfShowLiveProps } from "./XOS.types.ts";

/** Steps through cues with a countdown; Space or Go advances. Show mode enlarges cues for arm's-length reading. */
export function RunOfShowLive({
  cues,
  current,
  nextInSeconds,
  showMode = false,
  onGo,
}: RunOfShowLiveProps): ReactElement {
  const t = useT();
  const [live, setLive] = useState(current);
  const [left, setLeft] = useState(nextInSeconds);
  useEffect(() => {
    const timer = setInterval(() => setLeft((v) => v - 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const go = () => {
    const next = Math.min(live + 1, cues.length - 1);
    setLive(next);
    setLeft(cues[next]?.durationSeconds ?? 0);
    onGo?.(next);
  };
  return (
    <section
      aria-label={t("ros.label")}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === " " && e.target === e.currentTarget) {
          e.preventDefault();
          go();
        }
      }}
      className="flex flex-col max-w-(--layout-peek) rounded-card border border-border-subtle bg-bg-canvas"
    >
      <header className="flex items-center justify-between px-16 py-12 border-b border-border-subtle">
        <div className="flex flex-col">
          <span className="text-text-secondary">{t("ros.nextIn")}</span>
          <strong
            className={cx(
              "text-heading-32 font-semibold tabular-nums",
              left <= 30 && "text-warning-text",
            )}
          >
            {formatClock(left)}
          </strong>
        </div>
        <Button variant="primary" shortcut={t("key.space")} onClick={go}>
          {t("ros.go")}
        </Button>
      </header>
      <ol className="m-0 py-4 list-none">
        {cues.map((cue, i) => {
          const state = i < live ? "done" : i === live ? "live" : "next";
          return (
            <li
              key={cue.number}
              aria-current={state === "live" ? "true" : undefined}
              className={cx(
                "grid grid-cols-[max-content_max-content_minmax(0,1fr)_auto_auto] items-center gap-x-12 gap-y-8 px-16 py-4",
                showMode ? "min-h-(--ui-cmd-input) text-heading-20" : "min-h-(--space-40)",
                state === "done" && "text-text-tertiary",
                state === "live" &&
                  "bg-bg-hover font-semibold border-s-stroke-accent border-s-accent",
              )}
            >
              <span className="font-mono text-text-12">{cue.number}</span>
              <span className="tabular-nums text-text-secondary whitespace-nowrap">{cue.time}</span>
              <span>{cue.title}</span>
              {cue.dept ? (
                <DepartmentGlyph code={cue.dept} size={14} color="var(--color-text-secondary)" />
              ) : (
                <span />
              )}
              {state === "live" ? (
                <Tag tone="accent">{t("ros.live")}</Tag>
              ) : cue.status === "standby" ? (
                <Tag tone="warning">{t("ros.standby")}</Tag>
              ) : cue.status === "skipped" ? (
                <Tag>{t("ros.skipped")}</Tag>
              ) : (
                <span />
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
