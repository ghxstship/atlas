"use client";

import { Button, cx } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type DragEvent } from "react";
import type { ShiftCandidate } from "@xos/data/crew";
import {
  assignShiftAction,
  rankCandidatesAction,
  type CandidatesResult,
} from "@/app/[org]/crew/scheduling-actions";
import { FillMeter } from "./fill-meter";

export interface BoardShift {
  readonly id: string;
  /** Role and time, as the schedule shows them. */
  readonly label: string;
  readonly projectKey: string;
}

/**
 * The schedule's drag board (A132, ADR 0063, Section 11.11 crew fill): the week's open shifts on one side and the
 * org's members ranked for the chosen shift on the other (app.rank_shift_candidates: free of an overlapping shift,
 * then stated availability, then the role worked before, then the fewest hours that week). A planner drags a person
 * onto any open shift, or, from the keyboard, chooses a shift and presses Assign on a person. Every assignment is
 * announced, and the fill-rate meter moves at once, before the schedule rereads. Loaded on demand
 * (lazy-scheduling.tsx), so the schedule page carries none of it until a planner sees it.
 */
export function SchedulingBoard(props: {
  org: string;
  weekStart: string;
  openShifts: readonly BoardShift[];
  filled: number;
  total: number;
}) {
  const t = useTranslations("crew.scheduling");
  const router = useRouter();
  const [assigned, setAssigned] = useState<ReadonlySet<string>>(() => new Set());
  const [chosen, setChosen] = useState<string | null>(null);
  const [ranked, setRanked] = useState<Readonly<Record<string, CandidatesResult>>>({});
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [over, setOver] = useState<string | null>(null);
  const dragged = useRef<ShiftCandidate | null>(null);

  // Shifts assigned here leave the board and count as filled at once; the server's lists win as soon as the
  // schedule rereads (live updates, ADR 0044), since a shift it no longer lists as open is no longer pending.
  const open = props.openShifts.filter((s) => !assigned.has(s.id));
  const total = props.total;
  const filled = Math.min(total, props.filled + (props.openShifts.length - open.length));
  const selected = chosen && open.some((s) => s.id === chosen) ? chosen : (open[0]?.id ?? null);
  const result = selected ? ranked[selected] : undefined;
  const candidates = result?.ok ? result.candidates : null;
  const loadError = result && !result.ok ? result.error : "";

  // Rank the chosen shift's candidates once; an assignment clears the rankings, since hours and overlaps moved.
  useEffect(() => {
    if (!selected || ranked[selected]) return;
    let live = true;
    void rankCandidatesAction(props.org, selected, props.weekStart).then((r) => {
      if (live) setRanked((m) => ({ ...m, [selected]: r }));
    });
    return () => {
      live = false;
    };
  }, [selected, ranked, props.org, props.weekStart]);

  const percentOf = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 100));
  const meterText = t("fill.value", { filled, total, percent: percentOf(filled) });
  const shiftLabel = (id: string) => open.find((s) => s.id === id)?.label ?? "";
  const nameOf = (c: ShiftCandidate) => c.name ?? t("unnamed");

  const assign = async (shiftId: string, person: ShiftCandidate) => {
    if (busy) return;
    setBusy(true);
    const label = shiftLabel(shiftId);
    const outcome = await assignShiftAction(props.org, shiftId, person.membershipId);
    setBusy(false);
    if (!outcome.ok) {
      setAnnouncement(t("assignFailed", { name: nameOf(person), error: outcome.error ?? "" }));
      return;
    }
    const nextFilled = Math.min(total, filled + 1);
    setAssigned((a) => new Set(a).add(shiftId));
    setRanked({});
    setAnnouncement(
      t("assigned", {
        name: nameOf(person),
        shift: label,
        fill: t("fill.value", { filled: nextFilled, total, percent: percentOf(nextFilled) }),
      }),
    );
    router.refresh();
  };

  const dropProps = (shiftId: string) => ({
    onDragOver: (event: DragEvent<HTMLLIElement>) => {
      if (!dragged.current) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setOver(shiftId);
    },
    onDragLeave: () => setOver((o) => (o === shiftId ? null : o)),
    onDrop: (event: DragEvent<HTMLLIElement>) => {
      const person = dragged.current;
      dragged.current = null;
      setOver(null);
      if (!person) return;
      event.preventDefault();
      void assign(shiftId, person);
    },
  });

  return (
    <section
      aria-labelledby="scheduling-board-heading"
      className="flex flex-col gap-12 rounded-card border border-border-subtle p-12"
      data-testid="scheduling-board"
    >
      <div className="flex flex-wrap items-end justify-between gap-12">
        <div className="flex flex-col gap-4">
          <h2 id="scheduling-board-heading" className="m-0 text-text-14 font-semibold">
            {t("title")}
          </h2>
          <p id="scheduling-board-help" className="m-0 text-text-12 text-text-secondary">
            {t("help")}
          </p>
        </div>
        <FillMeter
          label={t("fill.label")}
          filled={filled}
          total={total}
          percent={percentOf(filled)}
          valueText={meterText}
        />
      </div>
      {open.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("noOpenShifts")}</p>
      ) : (
        <div className="grid gap-12 md:grid-cols-2">
          <div className="flex flex-col gap-8">
            <h3 id="board-open-shifts" className="m-0 text-text-13 font-medium">
              {t("openShifts", { count: open.length })}
            </h3>
            <ul
              aria-labelledby="board-open-shifts"
              className="m-0 flex list-none flex-col gap-4 p-0"
            >
              {open.map((s) => (
                <li
                  key={s.id}
                  {...dropProps(s.id)}
                  data-testid="board-open-shift"
                  className={cx(
                    "rounded-control border border-dashed",
                    over === s.id ? "border-accent bg-bg-hover" : "border-border-subtle",
                  )}
                >
                  <button
                    type="button"
                    aria-pressed={selected === s.id}
                    onClick={() => setChosen(s.id)}
                    className="flex w-full flex-col items-start gap-2 rounded-control px-8 py-6 text-start text-text-13 hover:bg-bg-hover aria-pressed:bg-bg-hover aria-pressed:font-medium"
                  >
                    <span>{s.label}</span>
                    <span className="text-text-12 text-text-secondary">{s.projectKey}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-8">
            <h3 id="board-candidates" className="m-0 text-text-13 font-medium">
              {selected ? t("rankedFor", { shift: shiftLabel(selected) }) : t("ranked")}
            </h3>
            {loadError ? (
              <p role="alert" className="m-0 text-text-13 text-danger-text">
                {loadError}
              </p>
            ) : candidates === null ? (
              <p className="m-0 text-text-13 text-text-secondary">{t("loading")}</p>
            ) : candidates.length === 0 ? (
              <p className="m-0 text-text-13 text-text-secondary">{t("noCandidates")}</p>
            ) : (
              <ol
                aria-labelledby="board-candidates"
                aria-describedby="scheduling-board-help"
                className="m-0 flex list-none flex-col gap-4 p-0"
              >
                {candidates.map((c) => (
                  <li
                    key={c.membershipId}
                    draggable={!busy}
                    onDragStart={(event) => {
                      dragged.current = c;
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", c.membershipId);
                    }}
                    onDragEnd={() => {
                      dragged.current = null;
                      setOver(null);
                    }}
                    data-testid="board-candidate"
                    className="flex cursor-grab flex-wrap items-center justify-between gap-8 rounded-control border border-border-subtle px-8 py-6"
                  >
                    <span className="flex flex-col gap-2">
                      <span className="text-text-13 font-medium">{nameOf(c)}</span>
                      <span className="flex flex-wrap gap-x-8 text-text-12 text-text-secondary">
                        <span
                          className={
                            c.availability === "Available"
                              ? "text-success-text"
                              : c.availability === "Unavailable"
                                ? "text-danger-text"
                                : undefined
                          }
                        >
                          {t(`availability.${c.availability}`)}
                        </span>
                        {c.overdue ? (
                          <span className="text-warning-text">{t("overdue")}</span>
                        ) : null}
                        {c.conflict ? (
                          <span className="text-danger-text">{t("conflict")}</span>
                        ) : null}
                        {c.workedRole ? <span>{t("workedRole")}</span> : null}
                        <span className="tabular-nums">
                          {t("weekHours", { hours: Math.round((c.weekMinutes / 60) * 10) / 10 })}
                        </span>
                      </span>
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!selected || busy}
                      onClick={() => selected && void assign(selected, c)}
                      aria-label={
                        selected
                          ? t("assignTo", { name: nameOf(c), shift: shiftLabel(selected) })
                          : t("assign")
                      }
                    >
                      {t("assign")}
                    </Button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
      <p aria-live="polite" role="status" className="sr-only" data-testid="board-announcement">
        {announcement}
      </p>
    </section>
  );
}
