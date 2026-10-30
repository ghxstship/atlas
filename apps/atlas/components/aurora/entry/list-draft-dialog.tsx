"use client";

import type {
  AuroraListDraft,
  AuroraPreviewRecord,
  AuroraProblem,
  AuroraRunOfShowFlag,
} from "@xos/ai/client";
import { problemKind } from "@xos/ai/entry";
import { checkRunOfShow, durationSeconds, durationText } from "@xos/ai/lists";
import { Button, Checkbox, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import { useCopy } from "@/components/work/action-ui";
import { fromLocalInput, toLocalInput } from "@/components/work/format";
import type { ListDraftEntryProps } from "./list-draft-entry";
import {
  AiGenerated,
  AiPanel,
  AvailabilityNotice,
  LiveRegion,
  OutcomeNotice,
  outcomeAnnouncement,
  outcomeOf,
  problemKey,
  SentList,
  useAurora,
  useEntryT,
  type Outcome,
} from "./shared";

/** A drafted cue as the person edits it: local time, length in minutes, text. */
interface CueRow {
  readonly suggestionId: string;
  readonly include: boolean;
  readonly label: string;
  /** A datetime-local value in the run's zone, or empty for an untimed cue. */
  readonly at: string;
  readonly minutes: string;
  readonly segment: string;
  readonly description: string;
}

interface RiskRow {
  readonly suggestionId: string;
  readonly include: boolean;
  readonly title: string;
  readonly category: string;
  readonly likelihood: string;
  readonly impact: string;
  readonly mitigation: string;
}

type Rows =
  | { readonly kind: "run_of_show"; readonly rows: readonly CueRow[] }
  | { readonly kind: "risk_assessment"; readonly rows: readonly RiskRow[] };

type Phase =
  | { readonly kind: "compose" }
  | { readonly kind: "sending" }
  | { readonly kind: "done"; readonly outcome: Outcome<AuroraListDraft> }
  | { readonly kind: "applying" }
  | { readonly kind: "discarding" };

const RATINGS = ["1", "2", "3", "4", "5"];

/** Whole minutes from 0 to 24 hours, or empty; anything else is not a length. */
function minutesOf(text: string): number | null | false {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 && n <= 1440 ? n : false;
}

const optional = (text: string) => (text.trim() === "" ? null : text.trim());
const rating = (text: string) => (text === "" ? null : Number(text));

/** The flag sentence of a run of show row, keyed by the cue it is about (the later of a pair). */
function flagKey(flag: AuroraRunOfShowFlag): string {
  return {
    overlap: "flags.overlap",
    gap: "flags.gap",
    untimed: "flags.untimed",
    out_of_order: "flags.outOfOrder",
  }[flag.type];
}

/**
 * Drafting a run of show or a risk assessment with Aurora (P6, Section 4.7, A95). The person says
 * what to draft, sees what Aurora receives (their words, the list's own records and the context,
 * read and scrubbed by aurora.preview exactly as the draft reads them, the vocabulary, and for
 * risks the canon categories), and sends it. The lines come back as editable rows, each with an
 * Include toggle; the gaps and clashes check runs again on every edit. Nothing is written until the
 * person adds the lines they keep, in one step, and only while the list is still empty.
 */
export function ListDraftDialog({
  kind,
  target,
  context,
  timeZone = "UTC",
  open,
  onOpenChange,
}: ListDraftEntryProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useEntryT();
  const work = useCopy("work");
  const id = useId();
  const router = useRouter();
  const { client, availability, check } = useAurora("drafting", open);
  const l = (key: string, values?: Record<string, string | number>) =>
    t(`listDraft.${key}`, values);
  const [instructions, setInstructions] = useState(() =>
    t(`listDraft.defaultInstructions.${kind}`, { name: target.label }),
  );
  const [records, setRecords] = useState<readonly AuroraPreviewRecord[] | "loading" | "error">(
    "loading",
  );
  const [vocabulary, setVocabulary] = useState(0);
  const [categories, setCategories] = useState<readonly string[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "compose" });
  const [rows, setRows] = useState<Rows | null>(null);
  // The draft under review, kept while its lines are added or discarded.
  const [answer, setAnswer] = useState<Extract<
    Outcome<AuroraListDraft>,
    { kind: "answer" }
  > | null>(null);
  const [problem, setProblem] = useState<AuroraProblem | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // The records named, compared by value: a caller may pass a new array on every render.
  const itemsKey = JSON.stringify(
    context.map(({ collection, id: rid }) => ({ collection, id: rid })),
  );
  const items = useMemo(
    () => JSON.parse(itemsKey) as { collection: string; id: string }[],
    [itemsKey],
  );
  const listTarget = useMemo(
    () => ({ collection: target.collection, id: target.id }),
    [target.collection, target.id],
  );

  useEffect(() => {
    if (!open) return;
    let live = true;
    void client
      .preview({ feature: "drafting", draft_kind: kind, target: listTarget, items })
      .then((r) => {
        if (!live) return;
        setRecords(r.ok ? r.data.records : "error");
        setVocabulary(r.ok ? r.data.vocabulary_terms : 0);
        setCategories(r.ok ? (r.data.categories ?? []) : []);
      });
    return () => {
      live = false;
    };
  }, [open, client, kind, listTarget, items]);

  const ready = availability.kind === "ready";
  const draft = answer?.answer ?? null;
  const shownCategories = draft?.kind === "risk_assessment" ? draft.categories : categories;

  const send = async () => {
    setPhase({ kind: "sending" });
    setProblem(null);
    setAnnouncement(t("sending"));
    const outcome = outcomeOf(
      await client.draft({
        kind,
        instructions: instructions.trim(),
        target: listTarget,
        context: items,
      }),
    );
    if (outcome.kind === "answer") {
      setAnswer(outcome);
      const value = outcome.answer;
      setRows(
        value.kind === "run_of_show"
          ? {
              kind: "run_of_show",
              rows: value.items.map((c) => ({
                suggestionId: c.suggestion_id,
                include: true,
                label: c.label,
                at: toLocalInput(c.planned_at, timeZone),
                minutes: c.duration === null ? "" : String((durationSeconds(c.duration) ?? 0) / 60),
                segment: c.segment ?? "",
                description: c.description ?? "",
              })),
            }
          : {
              kind: "risk_assessment",
              rows: value.items.map((r) => ({
                suggestionId: r.suggestion_id,
                include: true,
                title: r.title,
                category: r.category,
                likelihood: r.likelihood === null ? "" : String(r.likelihood),
                impact: r.impact === null ? "" : String(r.impact),
                mitigation: r.mitigation,
              })),
            },
      );
    }
    setPhase({ kind: "done", outcome });
    setAnnouncement(outcomeAnnouncement(outcome, t, l("ready")));
  };

  // The gaps and clashes check over the included cues, numbered as they will be added.
  const included = rows ? rows.rows.filter((r) => r.include) : [];
  const flags = useMemo(() => {
    if (!rows || rows.kind !== "run_of_show") return [];
    return checkRunOfShow(
      rows.rows
        .filter((r) => r.include)
        .map((r, i) => {
          const minutes = minutesOf(r.minutes);
          return {
            position: i + 1,
            plannedAt: fromLocalInput(r.at, timeZone),
            durationSeconds: typeof minutes === "number" ? minutes * 60 : null,
          };
        }),
    );
  }, [rows, timeZone]);

  const invalid = (row: CueRow | RiskRow): boolean => {
    if ("label" in row) {
      return (
        row.label.trim() === "" || row.label.trim().length > 200 || minutesOf(row.minutes) === false
      );
    }
    return (
      row.title.trim() === "" ||
      row.title.trim().length > 200 ||
      row.mitigation.trim() === "" ||
      row.mitigation.trim().length > 2000
    );
  };
  const canAdd = included.length > 0 && !included.some(invalid);

  const update = (index: number, change: Partial<CueRow> & Partial<RiskRow>) =>
    setRows((current) =>
      current === null
        ? current
        : current.kind === "run_of_show"
          ? {
              kind: "run_of_show",
              rows: current.rows.map((r, i) => (i === index ? { ...r, ...change } : r)),
            }
          : {
              kind: "risk_assessment",
              rows: current.rows.map((r, i) => (i === index ? { ...r, ...change } : r)),
            },
    );

  const add = async () => {
    if (!answer || !rows) return;
    const requestId = answer.requestId;
    if (!requestId) return;
    setPhase({ kind: "applying" });
    setProblem(null);
    const kept =
      rows.kind === "run_of_show"
        ? rows.rows
            .filter((r) => r.include)
            .map((r) => {
              const minutes = minutesOf(r.minutes);
              return {
                suggestion_id: r.suggestionId,
                values: {
                  label: r.label.trim(),
                  planned_at: fromLocalInput(r.at, timeZone),
                  duration: typeof minutes === "number" ? durationText(minutes) : null,
                  segment: optional(r.segment),
                  description: optional(r.description),
                },
              };
            })
        : rows.rows
            .filter((r) => r.include)
            .map((r) => ({
              suggestion_id: r.suggestionId,
              values: {
                record_subtype: r.category,
                title: r.title.trim(),
                "risk.likelihood": rating(r.likelihood),
                "risk.impact": rating(r.impact),
                "risk.mitigation": r.mitigation.trim(),
              },
            }));
    const result = await client.applyDraft({ request_id: requestId, items: kept });
    if (result.ok) {
      setAnnouncement(l(`added.${kind}`, { count: result.data.written.length }));
      onOpenChange(false);
      router.refresh();
      return;
    }
    setProblem(result.problem);
    setPhase({ kind: "done", outcome: answer });
    setAnnouncement(t(problemKey(result.problem), { detail: result.problem.detail }));
    // A list filled since the draft: the page shows the new entry and the button goes.
    if (problemKind(result.problem) === "list-not-empty") router.refresh();
  };

  const discard = async () => {
    if (!answer) {
      onOpenChange(false);
      return;
    }
    setPhase({ kind: "discarding" });
    const ids = answer.suggestions.map((s) => s.suggestion_id);
    // Ten at a time; a line that cannot be rejected now expires in 7 days.
    for (let i = 0; i < ids.length; i += 10) {
      await Promise.all(
        ids.slice(i, i + 10).map((s) => client.reject(s, "Discarded in the drafted list panel.")),
      );
    }
    setAnnouncement(l("discarded"));
    onOpenChange(false);
  };

  const recordLabel = (r: AuroraPreviewRecord) =>
    r.id === target.id ? target.label : (context.find((c) => c.id === r.id)?.label ?? r.collection);
  const busy = phase.kind === "applying" || phase.kind === "discarding";
  const reviewing = draft !== null && rows !== null;

  return (
    <>
      <LiveRegion message={announcement} />
      <AiPanel
        title={l(`title.${kind}`)}
        open={open}
        onOpenChange={onOpenChange}
        footer={
          reviewing || busy ? (
            <>
              <Button
                variant="ghost"
                loading={phase.kind === "discarding"}
                disabled={busy}
                onClick={() => void discard()}
              >
                {t("discard")}
              </Button>
              <Button
                variant="primary"
                loading={phase.kind === "applying"}
                disabled={!canAdd || busy}
                onClick={() => void add()}
              >
                {l(`add.${kind}`, { count: included.length })}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("close")}
              </Button>
              <Button
                variant="primary"
                icon="Sparkles"
                loading={phase.kind === "sending"}
                disabled={
                  !ready ||
                  instructions.trim() === "" ||
                  phase.kind === "sending" ||
                  records === "error"
                }
                onClick={() => void send()}
              >
                {t("send")}
              </Button>
            </>
          )
        }
      >
        <AvailabilityNotice availability={availability} onRetry={() => void check()} />
        {reviewing && draft ? (
          <div className="flex flex-col gap-12">
            <AiGenerated model={answer?.model ?? null} />
            <p className="m-0 text-text-12 text-text-secondary">{l("review")}</p>
            {kind === "risk_assessment" ? (
              <InlineAlert tone="warning">{l("qualified")}</InlineAlert>
            ) : null}
            {problem ? (
              <InlineAlert tone="danger">
                {t(problemKey(problem), { detail: problem.detail })}
              </InlineAlert>
            ) : null}
            {draft.gaps.length > 0 ? (
              <InlineAlert tone="warning" title={l("gapsTitle")}>
                <ul className="m-0 flex list-disc flex-col gap-2 ps-16">
                  {draft.gaps.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </InlineAlert>
            ) : null}
            {draft.dropped.length > 0 ? (
              <InlineAlert tone="info" title={l("droppedTitle")}>
                <ul className="m-0 flex list-disc flex-col gap-2 ps-16">
                  {draft.dropped.map((d) => (
                    <li key={d.line}>
                      {l("dropped", { line: d.line, reason: l(`dropReason.${d.reason}`) })}
                    </li>
                  ))}
                </ul>
              </InlineAlert>
            ) : null}
            {draft.verbiageMisses.length > 0 ? (
              <InlineAlert tone="info">
                {l("verbiage", { terms: draft.verbiageMisses.join(", ") })}
              </InlineAlert>
            ) : null}
            <ol
              className="m-0 flex list-none flex-col gap-12 p-0"
              aria-label={l(`rowsLabel.${kind}`)}
            >
              {rows.kind === "run_of_show"
                ? rows.rows.map((row, i) => {
                    const position = rows.rows.slice(0, i + 1).filter((r) => r.include).length;
                    const mine = row.include
                      ? flags.filter((f) => f.positions[f.positions.length - 1] === position)
                      : [];
                    return (
                      <li
                        key={row.suggestionId}
                        data-drafted-line={i + 1}
                        className="flex flex-col gap-8 rounded-control border border-border-subtle p-8"
                      >
                        <Checkbox
                          label={l("include", { n: i + 1 })}
                          checked={row.include}
                          onChange={(e) => update(i, { include: e.target.checked })}
                        />
                        <Input
                          id={`${id}-label-${i}`}
                          label={l("columns.label")}
                          width="100%"
                          value={row.label}
                          maxLength={200}
                          onChange={(e) => update(i, { label: e.target.value })}
                          error={row.include && row.label.trim() === "" ? l("required") : ""}
                        />
                        <div className="flex flex-wrap gap-8">
                          <Input
                            id={`${id}-at-${i}`}
                            type="datetime-local"
                            label={l("columns.time", { zone: timeZone })}
                            value={row.at}
                            onChange={(e) => update(i, { at: e.target.value })}
                          />
                          <Input
                            id={`${id}-minutes-${i}`}
                            label={l("columns.duration")}
                            inputMode="numeric"
                            width={140}
                            value={row.minutes}
                            onChange={(e) => update(i, { minutes: e.target.value })}
                            error={minutesOf(row.minutes) === false ? l("minutesInvalid") : ""}
                          />
                        </div>
                        <Input
                          id={`${id}-segment-${i}`}
                          label={l("columns.segment")}
                          width="100%"
                          maxLength={200}
                          value={row.segment}
                          onChange={(e) => update(i, { segment: e.target.value })}
                        />
                        <Textarea
                          id={`${id}-description-${i}`}
                          label={l("columns.description")}
                          width="100%"
                          rows={2}
                          maxLength={2000}
                          value={row.description}
                          onChange={(e) => update(i, { description: e.target.value })}
                        />
                        {mine.length > 0 ? (
                          <ul className="m-0 flex list-none flex-col gap-2 p-0" data-cue-flags>
                            {mine.map((f) => (
                              <li key={f.type} className="text-text-12 text-warning-text">
                                {l(flagKey(f), { minutes: f.minutes ?? 0 })}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    );
                  })
                : rows.rows.map((row, i) => (
                    <li
                      key={row.suggestionId}
                      data-drafted-line={i + 1}
                      className="flex flex-col gap-8 rounded-control border border-border-subtle p-8"
                    >
                      <Checkbox
                        label={l("include", { n: i + 1 })}
                        checked={row.include}
                        onChange={(e) => update(i, { include: e.target.checked })}
                      />
                      <Input
                        id={`${id}-title-${i}`}
                        label={l("columns.title")}
                        width="100%"
                        maxLength={200}
                        value={row.title}
                        onChange={(e) => update(i, { title: e.target.value })}
                        error={row.include && row.title.trim() === "" ? l("required") : ""}
                      />
                      <div className="flex flex-wrap gap-8">
                        <Select
                          label={l("columns.category")}
                          value={row.category}
                          options={shownCategories.map((c) => ({
                            value: c,
                            label: work(`subtypes.Risk.${c}`),
                          }))}
                          onChange={(e) => update(i, { category: e.target.value })}
                        />
                        <Select
                          label={l("columns.likelihood")}
                          value={row.likelihood}
                          options={[
                            { value: "", label: l("unrated") },
                            ...RATINGS.map((n) => ({ value: n, label: n })),
                          ]}
                          onChange={(e) => update(i, { likelihood: e.target.value })}
                        />
                        <Select
                          label={l("columns.impact")}
                          value={row.impact}
                          options={[
                            { value: "", label: l("unrated") },
                            ...RATINGS.map((n) => ({ value: n, label: n })),
                          ]}
                          onChange={(e) => update(i, { impact: e.target.value })}
                        />
                      </div>
                      <Textarea
                        id={`${id}-mitigation-${i}`}
                        label={l("columns.mitigation")}
                        width="100%"
                        rows={2}
                        maxLength={2000}
                        value={row.mitigation}
                        onChange={(e) => update(i, { mitigation: e.target.value })}
                        error={row.include && row.mitigation.trim() === "" ? l("required") : ""}
                      />
                    </li>
                  ))}
            </ol>
          </div>
        ) : (
          <div className="flex flex-col gap-12">
            <Textarea
              id={`${id}-instructions`}
              label={l("instructions")}
              help={l(`instructionsHelp.${kind}`)}
              width="100%"
              rows={4}
              maxLength={4000}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
            <SentList
              items={[
                { label: l("sentKind"), value: l(`kind.${kind}`) },
                { label: l("sentTarget"), value: target.label },
                {
                  label: t("draft.sentInstructions"),
                  value:
                    instructions.trim() === "" ? t("draft.noInstructions") : instructions.trim(),
                },
                ...(kind === "risk_assessment" && shownCategories.length > 0
                  ? [
                      {
                        label: l("sentCategories"),
                        value: shownCategories.map((c) => work(`subtypes.Risk.${c}`)).join(", "),
                      },
                    ]
                  : []),
              ]}
              records={records}
              recordLabel={recordLabel}
              vocabularyTerms={vocabulary}
            />
            {phase.kind === "sending" ? (
              <p role="status" className="m-0 text-text-13 text-text-secondary">
                {t("sending")}
              </p>
            ) : null}
            {phase.kind === "done" ? <OutcomeNotice outcome={phase.outcome} /> : null}
          </div>
        )}
      </AiPanel>
    </>
  );
}
