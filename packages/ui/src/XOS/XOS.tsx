import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { Direction } from "radix-ui";
import type {
  AccessGridMatrixProps as ReferenceAccessGridMatrixProps,
  AssertionRankBadgeProps as ReferenceAssertionRankBadgeProps,
  CoordinateMatrixProps as ReferenceCoordinateMatrixProps,
  EmergencyAuthority,
  EmergencyCodeCardProps as ReferenceEmergencyCodeCardProps,
  GateReadinessPanelProps as ReferenceGateReadinessPanelProps,
  ProvenanceBadgeProps as ReferenceProvenanceBadgeProps,
  RadioChannelTableProps as ReferenceRadioChannelTableProps,
  ReconciliationTableProps as ReferenceReconciliationTableProps,
  RunOfShowLiveProps as ReferenceRunOfShowLiveProps,
  StalenessIndicatorProps as ReferenceStalenessIndicatorProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useFormat, useT, type Translate } from "../lib/context.tsx";
import { formatClock } from "../lib/format.ts";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { DepartmentGlyph, PhaseGlyph } from "../Glyphs/Glyphs.tsx";
import { Tag, chipClass, codeClass } from "../Chips/Chips.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";
import { cardBodyClass, cardClass, cardFootClass, cardHeadClass } from "../Surface/Surface.tsx";

export type GateReadinessPanelProps = ReferenceGateReadinessPanelProps & {
  onAdvance?: () => void;
  onCriterionAction?: (code: string | undefined, label: string) => void;
};
export type ProvenanceBadgeProps = ReferenceProvenanceBadgeProps;
export type AssertionRankBadgeProps = ReferenceAssertionRankBadgeProps;
export type StalenessIndicatorProps = ReferenceStalenessIndicatorProps;
export type ReconciliationTableProps = ReferenceReconciliationTableProps;
export type EmergencyCodeCardProps = ReferenceEmergencyCodeCardProps;
export type RadioChannelTableProps = ReferenceRadioChannelTableProps;
export type RunOfShowLiveProps = ReferenceRunOfShowLiveProps & {
  /** Called with the new live cue index when Go advances. */
  onGo?: (index: number) => void;
};
export type CoordinateMatrixProps = ReferenceCoordinateMatrixProps & {
  onCellSelect?: (department: string, phase: string) => void;
};
export type AccessGridMatrixProps = ReferenceAccessGridMatrixProps & {
  onChange?: (grants: string[]) => void;
};

type Result = "met" | "gap" | "unknown";

const RESULT: Record<Result, { icon: string; className: string; key: string }> = {
  met: { icon: "CircleCheck", className: cx("text-success"), key: "result.met" },
  gap: { icon: "CircleX", className: cx("text-danger"), key: "result.gap" },
  unknown: { icon: "CircleHelp", className: cx("text-warning"), key: "result.unknown" },
};

function ResultIcon({
  result,
  t,
  labeled = true,
}: {
  result: Result;
  t: Translate;
  labeled?: boolean;
}) {
  const r = RESULT[result];
  return (
    <span className={r.className}>
      <Icon name={r.icon} size={14} {...(labeled ? { label: t(r.key) } : {})} />
    </span>
  );
}

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
      <footer className={cx(cardFootClass, "justify-between")}>
        <span className="text-text-secondary" aria-live="polite">
          {blockers
            ? t(blockers === 1 ? "gate.openOne" : "gate.openMany", { n: blockers })
            : t("gate.allMet")}
        </span>
        <Button variant="primary" disabled={blockers > 0} shortcut="⌘↵" onClick={onAdvance}>
          {nextLabel}
        </Button>
      </footer>
    </section>
  );
}

/** Who wrote a canon field and its provenance rank. */
export function ProvenanceBadge({ source, rank }: ProvenanceBadgeProps): ReactElement {
  const t = useT();
  return (
    <span className={chipClass} title={t("provenance.rank", { rank })}>
      <span className="text-text-secondary">{t("provenance.source")}</span>
      <span>{source}</span>
      <span className={codeClass}>
        <span className="sr-only">{t("provenance.rank", { rank })}</span>
        <span aria-hidden="true">{rank}</span>
      </span>
    </span>
  );
}

/** An assertion value with four pips for its rank from 4 down to 0. */
export function AssertionRankBadge({ label, rank }: AssertionRankBadgeProps): ReactElement {
  const t = useT();
  const on = rank === 4 ? "bg-success" : rank <= 1 ? "bg-warning" : "bg-text-secondary";
  return (
    <span role="img" aria-label={t("assertion.aria", { label, rank })} className={chipClass}>
      <span aria-hidden="true" className="inline-flex gap-2">
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={cx(
              "w-(--ui-pip-inline) h-(--ui-pip-block) rounded-mark",
              i <= rank ? on : "bg-border-strong",
            )}
          />
        ))}
      </span>
      <span aria-hidden="true">{label}</span>
    </span>
  );
}

/** A price band's age: degraded one step at 12 months, Modeled at 24, Expired at 36. */
export function StalenessIndicator({ months, basis }: StalenessIndicatorProps): ReactElement {
  const t = useT();
  const [key, tone] =
    months >= 36
      ? ["stale.expired", cx("text-danger")]
      : months >= 24
        ? ["stale.modeled", cx("text-warning")]
        : months >= 12
          ? ["stale.degraded", cx("text-warning")]
          : ["stale.current", cx("text-success")];
  return (
    <span
      className={chipClass}
      title={t("stale.title", { n: months, basis: basis ?? t("stale.basis") })}
    >
      <span className={tone}>
        <Icon name="Clock" size={14} />
      </span>
      <span>{t(key)}</span>
      <span className="text-text-secondary tabular-nums">{t("stale.months", { n: months })}</span>
    </span>
  );
}

const tableClass = cx("w-full border-collapse text-text-13");
const thClass = cx(
  "h-control-lg px-12 text-start font-medium text-text-12 text-text-secondary bg-bg-surface border-b border-border-subtle",
);
const tdClass = cx("h-row-default px-12 border-b border-border-subtle whitespace-nowrap");

/** Requirements against venue capability as Met, Gap or Unknown, with counts. */
export function ReconciliationTable({ label, rows }: ReconciliationTableProps): ReactElement {
  const t = useT();
  const counts: Record<"Met" | "Gap" | "Unknown", number> = { Met: 0, Gap: 0, Unknown: 0 };
  for (const r of rows) counts[r.result] += 1;
  const lower = (r: "Met" | "Gap" | "Unknown") => r.toLowerCase() as Result;
  return (
    <div className="flex flex-col gap-12">
      <div className="flex flex-wrap items-center gap-8">
        {(Object.keys(counts) as ("Met" | "Gap" | "Unknown")[]).map((k) => (
          <span key={k} className={chipClass}>
            <ResultIcon result={lower(k)} t={t} labeled={false} />
            {t(RESULT[lower(k)].key)}
            <span className="tabular-nums text-text-secondary">{counts[k]}</span>
          </span>
        ))}
      </div>
      <ScrollRegion label={label ?? t("scroll.region")}>
        <table className={tableClass}>
          <thead>
            <tr>
              <th scope="col" className={thClass}>
                {t("recon.requirement")}
              </th>
              <th scope="col" className={thClass}>
                {t("recon.capability")}
              </th>
              <th scope="col" className={thClass}>
                {t("recon.result")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.requirement}-${i}`} className="hover:bg-bg-hover">
                <td className={tdClass}>{r.requirement}</td>
                <td className={cx(tdClass, !r.capability && "text-text-secondary")}>
                  {r.capability ?? t("recon.notDeclared")}
                </td>
                <td className={tdClass}>
                  <span className="inline-flex items-center gap-6">
                    <ResultIcon result={lower(r.result)} t={t} labeled={false} />
                    {t(RESULT[lower(r.result)].key)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </div>
  );
}

const SERVICES: EmergencyAuthority["service"][] = [
  "fire",
  "ems",
  "lawEnforcement",
  "bombSquad",
  "federal",
];

/** Resolves `{service}` tokens in a protocol step from the jurisdiction's agencies, or the generic service name. */
export function resolveStep(
  step: string,
  authorities: EmergencyAuthority[] | undefined,
  t: Translate,
): string {
  return step.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (!(SERVICES as string[]).includes(key)) return match;
    const agency = authorities?.find((a) => a.service === key);
    return agency ? agency.agency : t(`ecode.service.${key}`);
  });
}

const SWATCH: Record<EmergencyCodeCardProps["swatch"], string> = {
  "ecode-red": cx("bg-ecode-red border-t-ecode-red"),
  "ecode-orange": cx("bg-ecode-orange border-t-ecode-orange"),
  "ecode-yellow": cx("bg-ecode-yellow border-t-ecode-yellow"),
  "ecode-green": cx("bg-ecode-green border-t-ecode-green"),
  "ecode-blue": cx("bg-ecode-blue border-t-ecode-blue"),
  "ecode-purple": cx("bg-ecode-purple border-t-ecode-purple"),
  "ecode-white": cx("bg-ecode-white border-t-ecode-white"),
  "ecode-black": cx("bg-ecode-black border-t-ecode-black"),
  "ecode-pink": cx("bg-ecode-pink border-t-ecode-pink"),
  "ecode-indigo": cx("bg-ecode-indigo border-t-ecode-indigo"),
  "ecode-silver": cx("bg-ecode-silver border-t-ecode-silver"),
  "ecode-grey": cx("bg-ecode-grey border-t-ecode-grey"),
  "ecode-amber": cx("bg-ecode-amber border-t-ecode-amber"),
  "ecode-adam": cx("bg-ecode-adam border-t-ecode-adam"),
};

/**
 * One global emergency code's protocol for one operational domain. The code word is always written;
 * the swatch is for recognition only. Steps name services; the jurisdiction supplies the agencies.
 */
export function EmergencyCodeCard({
  authorities,
  recordKey,
  code,
  name,
  swatch,
  domain,
  steps,
  channel,
}: EmergencyCodeCardProps): ReactElement {
  const t = useT();
  const used = SERVICES.filter((s) => steps.some((step) => step.includes(`{${s}}`)));
  const listed = (authorities ?? [])
    .filter((a) => used.includes(a.service))
    .sort((a, b) => SERVICES.indexOf(a.service) - SERVICES.indexOf(b.service));
  const tone = SWATCH[swatch] ?? SWATCH["ecode-red"];
  return (
    <article
      aria-labelledby={`${recordKey ?? code}-title`}
      className={cx(
        "flex flex-col gap-8 w-(--ui-popover) max-w-full p-16 box-border rounded-card bg-bg-raised",
        "border border-border-subtle border-t-stroke-swatch",
        tone.split(" ")[1],
      )}
    >
      <header className="flex items-center gap-8">
        <span
          aria-hidden="true"
          className={cx(
            "flex-none size-icon-24 rounded-chip ring-(length:--stroke-width-hairline) ring-inset ring-border-control",
            tone.split(" ")[0],
          )}
        />
        <div className="flex flex-col">
          <strong id={`${recordKey ?? code}-title`} className="text-heading-16 font-semibold">
            {code}
          </strong>
          <span>{name}</span>
        </div>
        {recordKey ? (
          <span className="ms-auto font-mono text-text-12 text-text-secondary">{recordKey}</span>
        ) : null}
      </header>
      {domain ? (
        <span className="text-text-12 font-medium text-text-secondary">{domain}</span>
      ) : null}
      <ol className="flex flex-col gap-4 m-0 ps-20">
        {steps.map((step, i) => (
          <li key={i}>{resolveStep(step, authorities, t)}</li>
        ))}
      </ol>
      {listed.length ? (
        <dl
          aria-label={t("ecode.authorities")}
          className="flex flex-col gap-4 m-0 pt-8 border-t border-border-subtle"
        >
          {listed.map((a) => (
            <div key={a.service} className="flex gap-8">
              <dt className="flex-none w-(--ui-props-label) text-text-12 font-medium text-text-secondary">
                {t(`ecode.role.${a.service}`)}
              </dt>
              <dd className="m-0">
                {a.agency}
                {a.contact ? (
                  <span className="text-text-secondary tabular-nums"> · {a.contact}</span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {channel ? (
        <footer className="flex items-center gap-6 text-text-12 text-text-secondary">
          <Icon name="Radio" size={14} />
          <span>{channel}</span>
        </footer>
      ) : null}
    </article>
  );
}

/** The radio plan, always sorted by zone then channel; notes wrap so it reads on a phone. */
export function RadioChannelTable({ caption, channels }: RadioChannelTableProps): ReactElement {
  const t = useT();
  const sorted = [...channels].sort((a, b) => a.zone - b.zone || a.channel - b.channel);
  return (
    <ScrollRegion label={caption ?? t("scroll.region")}>
      <table className={tableClass}>
        {caption ? <caption className="pb-8 text-start font-semibold">{caption}</caption> : null}
        <thead>
          <tr>
            {["radio.zone", "radio.channel", "radio.assignment", "radio.notes"].map((k) => (
              <th key={k} scope="col" className={thClass}>
                {t(k)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => (
            <tr key={`${c.zone}.${c.channel}`}>
              <td className={cx(tdClass, "tabular-nums")}>{c.zone}</td>
              <td className={tdClass}>
                <span className={codeClass}>{c.channel}</span>
              </td>
              <td className={tdClass}>
                <strong className="font-semibold">{c.assignment}</strong>
              </td>
              <td
                className={cx(
                  tdClass,
                  "whitespace-normal py-8 min-w-(--ui-skeleton-inline) text-text-secondary",
                )}
              >
                {c.notes}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

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
              {state === "live" ? <Tag tone="accent">{t("ros.live")}</Tag> : <span />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const SEQ: Record<number, string> = {
  2: cx("bg-viz-seq-2 text-viz-ink"),
  3: cx("bg-viz-seq-3 text-viz-ink"),
  4: cx("bg-viz-seq-4 text-viz-ink"),
  5: cx("bg-viz-seq-5 text-viz-ink"),
  6: cx("bg-viz-seq-6 text-accent-text-on"),
  7: cx("bg-viz-seq-7 text-accent-text-on"),
  8: cx("bg-viz-seq-8 text-accent-text-on"),
  9: cx("bg-viz-seq-9 text-accent-text-on"),
};

const CAT: Record<number, string> = {
  1: cx("bg-viz-cat-1"),
  2: cx("bg-viz-cat-2"),
  3: cx("bg-viz-cat-3"),
  4: cx("bg-viz-cat-4"),
  5: cx("bg-viz-cat-5"),
  6: cx("bg-viz-cat-6"),
  7: cx("bg-viz-cat-7"),
};

/** Roving focus over the cells of an ARIA grid: arrows move, Home and End jump within a row, Ctrl with them jumps to the corners. */
function useGridFocus(rows: number, cols: number) {
  const dir = Direction.useDirection();
  const [active, setActive] = useState<[number, number]>([0, 0]);
  const refs = useRef(new Map<string, HTMLElement>());
  const register = (r: number, c: number) => (el: HTMLElement | null) => {
    if (el) refs.current.set(`${r}:${c}`, el);
    else refs.current.delete(`${r}:${c}`);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>, r: number, c: number) => {
    const forward = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    const back = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    const ctrl = e.ctrlKey || e.metaKey;
    const target: [number, number] | null =
      e.key === "ArrowDown"
        ? [r + 1, c]
        : e.key === "ArrowUp"
          ? [r - 1, c]
          : e.key === forward
            ? [r, c + 1]
            : e.key === back
              ? [r, c - 1]
              : e.key === "Home"
                ? ctrl
                  ? [0, 0]
                  : [r, 0]
                : e.key === "End"
                  ? ctrl
                    ? [rows - 1, cols - 1]
                    : [r, cols - 1]
                  : null;
    if (!target) return;
    e.preventDefault();
    const next: [number, number] = [
      Math.max(0, Math.min(rows - 1, target[0])),
      Math.max(0, Math.min(cols - 1, target[1])),
    ];
    setActive(next);
    refs.current.get(`${next[0]}:${next[1]}`)?.focus();
  };
  const tabIndex = (r: number, c: number) => (active[0] === r && active[1] === c ? 0 : -1);
  return { register, onKeyDown, tabIndex, setActive };
}

/**
 * The 10 departments crossed with the 9 phases. An ARIA grid: arrows move between cells, Enter
 * drills into a coordinate's records. Empty coordinates are outlined, not filled.
 */
export function CoordinateMatrix({
  label,
  corner,
  rows,
  cols,
  cells,
  onCellSelect,
}: CoordinateMatrixProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  const grid = useGridFocus(rows.length, cols.length);
  const max = Math.max(0, ...Object.values(cells));
  const step = (v: number) => (v ? Math.min(9, 2 + Math.round((v / max) * 6)) : 0);
  return (
    <ScrollRegion label={label}>
      <table
        role="grid"
        aria-label={label}
        className="border-separate border-spacing-2 text-text-12"
      >
        <caption className="pb-8 text-start text-text-13 font-semibold">{label}</caption>
        <thead>
          <tr>
            <th scope="col" className="p-4 text-start font-medium text-text-secondary">
              {corner}
            </th>
            {cols.map((c) => (
              <th
                key={c.code}
                scope="col"
                title={c.name}
                className="p-4 font-medium text-text-secondary text-center"
              >
                <span className="flex flex-col items-center gap-2">
                  <PhaseGlyph
                    code={c.code}
                    size={14}
                    label={t("phase.gateName", { n: c.gate, name: c.name })}
                  />
                  <span aria-hidden="true" className="tabular-nums">
                    {c.gate}
                  </span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={r.code}>
              <th scope="row" className="pe-12 text-start font-medium whitespace-nowrap">
                <span className="inline-flex items-center gap-6">
                  <DepartmentGlyph code={r.code} size={14} color="var(--color-text-secondary)" />
                  <span>{r.name}</span>
                  <span className="font-mono text-text-secondary">{r.code}</span>
                </span>
              </th>
              {cols.map((c, ci) => {
                const v = cells[`${r.code}|${c.code}`] ?? 0;
                const s = step(v);
                const name = v
                  ? t("matrix.cell", { row: r.name, col: c.name, n: fmt.number(v) })
                  : t("matrix.empty", { row: r.name, col: c.name });
                return (
                  <td
                    key={c.code}
                    ref={grid.register(ri, ci)}
                    role="gridcell"
                    tabIndex={grid.tabIndex(ri, ci)}
                    aria-label={name}
                    onFocus={() => grid.setActive([ri, ci])}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === " ") && v) {
                        e.preventDefault();
                        onCellSelect?.(r.code, c.code);
                      } else grid.onKeyDown(e, ri, ci);
                    }}
                    onClick={() => (v ? onCellSelect?.(r.code, c.code) : undefined)}
                    className={cx(
                      "xos-hit w-(--space-48) h-control-md rounded-chip text-center font-semibold tabular-nums",
                      v
                        ? cx(
                            SEQ[s],
                            "cursor-pointer hover:outline-solid hover:outline-stroke-focus hover:outline-text-primary",
                          )
                        : "ring-(length:--stroke-width-hairline) ring-inset ring-border-subtle",
                      "forced-colors:border",
                    )}
                  >
                    {v ? <span aria-hidden="true">{fmt.number(v)}</span> : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

/**
 * Which credential categories enter which zones; Compass validates scans against it offline. An
 * ARIA grid: arrows move, Space or Enter toggles a grant.
 */
export function AccessGridMatrix({
  label,
  zones,
  categories,
  grants,
  onChange,
}: AccessGridMatrixProps): ReactElement {
  const t = useT();
  const [granted, setGranted] = useState(grants);
  const grid = useGridFocus(categories.length, zones.length);
  const has = (cat: string, zone: string) => granted.includes(`${cat}|${zone}`);
  const toggle = (cat: string, zone: string) => {
    const key = `${cat}|${zone}`;
    const next = has(cat, zone) ? granted.filter((g) => g !== key) : [...granted, key];
    setGranted(next);
    onChange?.(next);
  };
  return (
    <ScrollRegion label={label}>
      <table
        role="grid"
        aria-label={label}
        className="border-separate border-spacing-2 text-text-12"
      >
        <caption className="pb-8 text-start text-text-13 font-semibold">{label}</caption>
        <thead>
          <tr>
            <th scope="col" className="p-4 text-start font-medium text-text-secondary">
              {t("access.credential")}
            </th>
            {zones.map((z) => (
              <th key={z} scope="col" className="p-4 font-medium text-text-secondary">
                {z}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {categories.map((cat, ri) => (
            <tr key={cat.name}>
              <th scope="row" className="pe-12 text-start font-medium whitespace-nowrap">
                <span className="inline-flex items-center gap-6">
                  <span
                    aria-hidden="true"
                    className={cx(
                      "inline-block size-(--ui-switch-knob) rounded-mark",
                      CAT[cat.color],
                    )}
                  />
                  {cat.name}
                </span>
              </th>
              {zones.map((zone, ci) => {
                const on = has(cat.name, zone);
                return (
                  <td
                    key={zone}
                    ref={grid.register(ri, ci)}
                    role="gridcell"
                    aria-selected={on}
                    aria-label={t(on ? "access.allowed" : "access.denied", { cat: cat.name, zone })}
                    tabIndex={grid.tabIndex(ri, ci)}
                    onFocus={() => grid.setActive([ri, ci])}
                    onClick={() => toggle(cat.name, zone)}
                    onKeyDown={(e) => {
                      if (e.key === " " || e.key === "Enter") {
                        e.preventDefault();
                        toggle(cat.name, zone);
                      } else grid.onKeyDown(e, ri, ci);
                    }}
                    className={cx(
                      "xos-hit w-(--space-40) h-control-md rounded-chip text-center cursor-pointer",
                      on
                        ? "bg-bg-hover text-success ring-(length:--stroke-width-hairline) ring-inset ring-success"
                        : "bg-bg-surface text-text-tertiary ring-(length:--stroke-width-hairline) ring-inset ring-border-subtle",
                      "forced-colors:border",
                    )}
                  >
                    <Icon name={on ? "Check" : "Minus"} size={14} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
