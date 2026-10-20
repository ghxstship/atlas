import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { PhaseGlyph } from "../Glyphs/Glyphs.tsx";
import { Tag, chipClass } from "../Chips/Chips.tsx";
import { cardBodyClass, cardClass, cardFootClass, cardHeadClass } from "../Surface/Surface.tsx";
import { ResultIcon } from "./XOS.shared.tsx";
import { type GateReadinessPanelProps } from "./XOS.types.ts";

/**
 * A gate's criteria as a checklist with evidence, blocking flags and the action that clears each
 * gap. The next-gate button enables when the last blocking criterion is met.
 */
export function GateReadinessPanel({
  gate,
  code,
  name,
  nextLabel,
  criteria,
  onAdvance,
  onCriterionAction,
}: GateReadinessPanelProps): ReactElement {
  const t = useT();
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
                <Button size="sm" onClick={() => onCriterionAction?.(c.code, c.label)}>
                  {c.action}
                </Button>
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
        <Button
          variant="primary"
          disabled={blockers > 0}
          shortcut="⌘↵"
          onClick={onAdvance}
          className="max-sm:w-full"
        >
          {nextLabel}
        </Button>
      </footer>
    </section>
  );
}
