import { type ReactElement, type ReactNode } from "react";
import { cx } from "../lib/cx.ts";
import { Icon } from "../Icon/Icon.tsx";
import { PhaseGlyph } from "../Glyphs/Glyphs.tsx";
import { Tag } from "../Chips/Tag.tsx";
import { chipClass } from "../Chips/chipClass.tsx";
import { cardBodyClass, cardClass, cardFootClass, cardHeadClass } from "../Surface/Surface.tsx";
import { ResultIcon } from "./ResultIcon.tsx";
import { type GateReadinessPanelProps } from "./XOS.types.ts";

type Criterion = GateReadinessPanelProps["criteria"][number];

export interface GateReadinessPanelViewProps extends Pick<
  GateReadinessPanelProps,
  "gate" | "code" | "name" | "criteria"
> {
  /** Looks up a `ui` message and fills its arguments. */
  t: (key: string, vars?: Record<string, string | number>) => string;
  /** Draws the control that clears an open criterion. */
  criterionAction: (criterion: Criterion) => ReactNode;
  /** Draws the next-gate control; `blocked` is true while a blocking criterion is open. */
  advance: (blocked: boolean) => ReactNode;
}

/**
 * The markup of GateReadinessPanel with its strings and controls passed in. It uses no hooks, no
 * context and no handlers of its own, so the provider-bound panel in `@xos/ui` and the
 * server-rendered one in `@xos/ui/marketing` draw the same thing (ADR 0027).
 */
export function GateReadinessPanelView({
  gate,
  code,
  name,
  criteria,
  t,
  criterionAction,
  advance,
}: GateReadinessPanelViewProps): ReactElement {
  const met = criteria.filter((c) => c.result === "met").length;
  const blockers = criteria.filter((c) => c.blocking && c.result !== "met").length;
  return (
    <section aria-label={t("gate.readiness")} className={cx(cardClass, "max-w-(--layout-form)")}>
      <header className={cardHeadClass}>
        <span className="flex items-center gap-8">
          <PhaseGlyph code={code} color="var(--color-text-secondary)" />
          <strong className="font-semibold">{t("phase.gateName", { n: gate, name })}</strong>
        </span>
        <span className="text-text-secondary tabular-nums">
          {t("gate.metCount", { met, total: criteria.length })}
        </span>
      </header>
      <div className={cardBodyClass}>
        <div
          role="progressbar"
          aria-label={t("gate.criteriaMet")}
          aria-valuenow={met}
          aria-valuemin={0}
          aria-valuemax={criteria.length}
          className="h-(--space-4) rounded-pill bg-bg-hover overflow-hidden"
        >
          <div
            className="h-full rounded-pill bg-success forced-colors:bg-[Highlight]"
            style={{ inlineSize: `${criteria.length ? (met / criteria.length) * 100 : 0}%` }}
          />
        </div>
        <ul className="xos-criteria m-0 p-0 list-none">
          {criteria.map((c) => (
            <li
              key={c.code ?? c.label}
              className="flex items-center gap-8 min-h-(--space-40) border-b border-border-subtle last:border-b-0"
            >
              <ResultIcon result={c.result} t={t} />
              {c.code ? (
                <span className="font-mono text-text-12 text-text-secondary">{c.code}</span>
              ) : null}
              <span className="xos-criteria-label flex-1">{c.label}</span>
              {c.blocking ? (
                <Tag tone={c.result === "met" ? "neutral" : "danger"}>{t("gate.blocking")}</Tag>
              ) : null}
              {c.evidence ? (
                <span className={chipClass}>
                  <Icon name="Paperclip" size={12} />
                  {c.evidence}
                </span>
              ) : c.result !== "met" && c.action ? (
                criterionAction(c)
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      {/* On a narrow card the action takes its own full-width line under the count (A59-023). */}
      <footer className={cx(cardFootClass, "justify-between flex-wrap")}>
        <span className="text-text-secondary" aria-live="polite">
          {blockers
            ? t(blockers === 1 ? "gate.openOne" : "gate.openMany", { n: blockers })
            : t("gate.allMet")}
        </span>
        {advance(blockers > 0)}
      </footer>
    </section>
  );
}
