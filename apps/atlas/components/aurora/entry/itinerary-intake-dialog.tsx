"use client";

import type {
  AuroraCandidate,
  AuroraItineraryFlag,
  AuroraProblem,
  AuroraSuggestion,
} from "@xos/ai/client";
import { checkItinerary, localInstant, type ItineraryLine } from "@xos/ai/itinerary";
import { Button, Checkbox, InlineAlert, Input, Select, Tag } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  fieldOf,
  fileSource,
  InboxPicker,
  MAX_FILE_BYTES,
  MAX_INTAKE_FILES,
  ProblemAlert,
  textOf,
  useRequestsLeft,
} from "./intake-shared";
import type { ItineraryIntakeEntryProps } from "./intake-entry";
import {
  AiGenerated,
  AiPanel,
  AvailabilityNotice,
  LiveRegion,
  useAurora,
  useEntryT,
} from "./shared";

interface Row {
  readonly suggestionId: string;
  readonly include: boolean;
  readonly passenger: string;
  readonly personId: string;
  readonly candidates: readonly AuroraCandidate[];
  readonly travelMode: string;
  readonly service: string;
  readonly departsFrom: string;
  readonly departsLocal: string;
  readonly departsZone: string;
  readonly arrivesAtPlace: string;
  readonly arrivesLocal: string;
  readonly arrivesZone: string;
  readonly flags: readonly AuroraItineraryFlag["type"][];
  /** The traveler already has this segment live (same service and departure), as the apply would refuse it. */
  readonly booked: boolean;
  readonly excerpt: string;
}

type Phase =
  | { readonly kind: "pick" }
  | { readonly kind: "reading"; readonly done: number; readonly total: number }
  | { readonly kind: "review"; readonly batchId: string; readonly model: string | null }
  | { readonly kind: "added"; readonly count: number };

function rowOf(
  s: AuroraSuggestion,
  candidates: readonly AuroraCandidate[],
  flags: AuroraItineraryFlag["type"][],
): Row {
  const best = candidates[0];
  return {
    suggestionId: s.id,
    // A row repeating another of the batch is left out until the person keeps it; one the traveler
    // already has is left out once the booked check finds it.
    include: !flags.includes("duplicate_in_batch"),
    passenger: textOf(s, "passenger_name"),
    personId: best?.person_id ?? "",
    candidates,
    travelMode: textOf(s, "travel_mode") || "Flight",
    service: textOf(s, "service_identifier"),
    departsFrom: textOf(s, "departs_from"),
    departsLocal: textOf(s, "departs_local"),
    departsZone: textOf(s, "departs_time_zone"),
    arrivesAtPlace: textOf(s, "arrives_at_place"),
    arrivesLocal: textOf(s, "arrives_local"),
    arrivesZone: textOf(s, "arrives_time_zone"),
    flags,
    booked: false,
    excerpt:
      fieldOf(s, "departs_local")?.source_excerpt ??
      fieldOf(s, "passenger_name")?.source_excerpt ??
      "",
  };
}

const lineOf = (r: Row): ItineraryLine => ({
  passengerName: r.passenger,
  travelMode: r.travelMode,
  serviceIdentifier: r.service || null,
  departsFrom: r.departsFrom,
  departsLocal: r.departsLocal || null,
  departsTimeZone: r.departsZone || null,
  arrivesAtPlace: r.arrivesAtPlace,
  arrivesLocal: r.arrivesLocal || null,
  arrivesTimeZone: r.arrivesZone || null,
});

/**
 * Import itineraries with Aurora (B15, parity gap G-59). The person picks up to 25 files and verified
 * project inbox messages; each is read as one metered request into an intake batch, and the preview
 * lists one row per proposed segment with its traveler, zones, times, checks and excerpt. The
 * traveler always comes from the person: a candidate is a hint. "Add segments" files the kept rows
 * under the Travel fulfillment in one transaction; Discard closes the batch and rejects them all.
 */
export function ItineraryIntakeDialog({
  projectId,
  fulfillmentId,
  people,
  inbox,
  open,
  onOpenChange,
}: ItineraryIntakeEntryProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useEntryT();
  const id = useId();
  const router = useRouter();
  const { client, availability, check } = useAurora("extraction", open);
  const left = useRequestsLeft(client, open);
  const [files, setFiles] = useState<File[]>([]);
  const [messages, setMessages] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [rows, setRows] = useState<Row[]>([]);
  const [problem, setProblem] = useState<AuroraProblem | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const total = files.length + messages.length;
  const tooBig = files.some((f) => f.size > MAX_FILE_BYTES);
  const ready = availability.kind === "ready";

  const read = async () => {
    setProblem(null);
    const started = await client.startIntake({
      project_id: projectId,
      kind: "Itineraries",
      file_count: total,
      fulfillment_id: fulfillmentId,
    });
    if (!started.ok) return setProblem(started.problem);
    const batchId = started.data.id;
    const found: {
      suggestionId: string;
      candidates: AuroraCandidate[];
      flags: AuroraItineraryFlag["type"][];
    }[] = [];
    let model: string | null = null;
    const sources = [
      ...messages.map((m) => ({ inbound_message_id: m })),
      ...files.map((f) => ({ file: f })),
    ];
    for (const [i, source] of sources.entries()) {
      setPhase({ kind: "reading", done: i, total: sources.length });
      setAnnouncement(t("intake.reading", { done: i + 1, total: sources.length }));
      const result = await client.extract({
        kind: "itinerary",
        intake_batch_id: batchId,
        ...("file" in source ? await fileSource(source.file) : source),
      });
      if (!result.ok) {
        setProblem(result.problem);
        continue;
      }
      model = result.data.model ?? model;
      const answer = result.data.answer;
      result.data.suggestions.forEach((s, line) => {
        found.push({
          suggestionId: s.suggestion_id,
          candidates: (answer?.candidates ?? []).filter((c) => c.name_index === line + 1),
          flags: (answer?.checks ?? []).filter((f) => f.line === line).map((f) => f.type),
        });
      });
    }
    const batch = await client.getIntake(batchId);
    if (!batch.ok) return setProblem(batch.problem);
    setRows(
      found.flatMap((f) => {
        const s = batch.data.suggestions.find((x) => x.id === f.suggestionId);
        return s ? [rowOf(s, f.candidates, f.flags)] : [];
      }),
    );
    setPhase({ kind: "review", batchId, model });
    setAnnouncement(t("intake.itineraries.ready"));
  };

  // Live checks on every edit: an arrival before its departure and a repeated segment. The airport
  // check needs the database's codes, so it keeps the flag the server set.
  const live = useMemo(() => {
    const included = rows.map(lineOf);
    const flags = checkItinerary(
      included,
      new Set(
        included.flatMap((l) =>
          [l.departsFrom ?? "", l.arrivesAtPlace ?? ""].flatMap(
            (p) => p.match(/\b[A-Z]{3}\b/g) ?? [],
          ),
        ),
      ),
    );
    return rows.map((r, i) => {
      const own = flags
        .filter((f) => f.line === i && f.type !== "unknown_airport" && f.type !== "inferred_zone")
        .map((f) => f.type);
      const kept = r.flags.filter(
        (f) => f === "unknown_airport" || f === "inferred_zone" || f === "inferred_year",
      );
      return [...new Set([...kept, ...own])];
    });
  }, [rows]);

  const instantsOf = (r: Row) => ({
    departsAt: localInstant(r.departsLocal || null, r.departsZone || null),
    arrivesAt: localInstant(r.arrivesLocal || null, r.arrivesZone || null),
  });

  // Already booked: whenever a row's traveler, service or departure changes, ask which rows the traveler
  // already has as a live segment, and leave each such row out the first time it is found, so one repeat
  // never refuses the whole batch. The person may keep a row again; the apply still decides.
  const batchId = phase.kind === "review" ? phase.batchId : null;
  const checkable = rows.map((r) => ({
    person_id: r.personId,
    service_identifier: r.service.trim() || null,
    departs_at: instantsOf(r).departsAt,
  }));
  const checkKey = JSON.stringify(checkable);
  const leftOut = useRef(new Set<string>());
  useEffect(() => {
    if (!batchId) return;
    const asked = checkable
      .map((row, i) => ({ row, i }))
      .filter(({ row }) => row.person_id && row.service_identifier && row.departs_at);
    let live = true;
    const timer = setTimeout(() => {
      if (asked.length === 0) {
        setRows((current) => current.map((r) => (r.booked ? { ...r, booked: false } : r)));
        return;
      }
      void client
        .checkItineraries(
          batchId,
          asked.map(({ row }) => row),
        )
        .then((result) => {
          if (!live || !result.ok) return;
          const booked = new Set(result.data.booked.map((n) => asked[n - 1]?.i));
          setRows((current) =>
            current.map((r, i) => {
              const isBooked = booked.has(i);
              const key = JSON.stringify(checkable[i]);
              if (isBooked && !leftOut.current.has(key)) {
                leftOut.current.add(key);
                return { ...r, booked: true, include: false };
              }
              return r.booked === isBooked ? r : { ...r, booked: isBooked };
            }),
          );
        });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // checkKey stands for the rows' traveler, service and departure; the rest of a row never changes the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId, checkKey, client]);
  const kept = rows.filter((r) => r.include);
  const invalid = kept.some((r) => {
    const at = instantsOf(r);
    return (
      !r.personId ||
      !at.departsAt ||
      !r.departsFrom.trim() ||
      !r.arrivesAtPlace.trim() ||
      !r.arrivesZone
    );
  });

  const add = async (batchId: string) => {
    setProblem(null);
    const result = await client.applyItineraries(
      batchId,
      kept.map((r) => {
        const at = instantsOf(r);
        const person = people.find((p) => p.personId === r.personId);
        const candidate = r.candidates.find((c) => c.person_id === r.personId);
        const engagement = candidate?.engagement_id ?? person?.engagementId ?? null;
        return {
          suggestion_id: r.suggestionId,
          values: {
            person_id: r.personId,
            ...(engagement ? { engagement_id: engagement } : {}),
            travel_mode: r.travelMode,
            departs_from: r.departsFrom,
            departs_at: at.departsAt,
            departs_time_zone: r.departsZone,
            arrives_at_place: r.arrivesAtPlace,
            ...(at.arrivesAt ? { arrives_at: at.arrivesAt } : {}),
            arrives_time_zone: r.arrivesZone,
            ...(r.service ? { service_identifier: r.service } : {}),
          },
        };
      }),
    );
    if (!result.ok) return setProblem(result.problem);
    setPhase({ kind: "added", count: result.data.written.length });
    setAnnouncement(t("intake.itineraries.added", { count: result.data.written.length }));
    router.refresh();
  };

  const discard = async (batchId: string) => {
    await client.closeIntake(batchId);
    onOpenChange(false);
  };

  const set = (i: number, patch: Partial<Row>) =>
    setRows((current) => current.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const options = (r: Row) => [
    { value: "", label: t("intake.itineraries.pickTraveler") },
    ...r.candidates.map((c) => ({
      value: c.person_id ?? "",
      label: t("intake.candidate", { name: c.full_name ?? "" }),
    })),
    ...people
      .filter((p) => !r.candidates.some((c) => c.person_id === p.personId))
      .map((p) => ({ value: p.personId, label: p.label })),
  ];

  return (
    <>
      <LiveRegion message={announcement} />
      <AiPanel
        title={t("intake.itineraries.title")}
        open={open}
        onOpenChange={onOpenChange}
        footer={
          phase.kind === "review" ? (
            <>
              <Button variant="ghost" onClick={() => void discard(phase.batchId)}>
                {t("discard")}
              </Button>
              <Button
                variant="primary"
                disabled={kept.length === 0 || invalid}
                onClick={() => void add(phase.batchId)}
              >
                {t("intake.itineraries.add", { count: kept.length })}
              </Button>
            </>
          ) : phase.kind === "added" ? (
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              {t("close")}
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("close")}
              </Button>
              <Button
                variant="primary"
                icon="Sparkles"
                loading={phase.kind === "reading"}
                disabled={
                  !ready ||
                  total === 0 ||
                  total > MAX_INTAKE_FILES ||
                  tooBig ||
                  phase.kind === "reading"
                }
                onClick={() => void read()}
              >
                {t("intake.read", { count: total })}
              </Button>
            </>
          )
        }
      >
        <AvailabilityNotice availability={availability} onRetry={() => void check()} />
        <ProblemAlert t={t} problem={problem} />
        {phase.kind === "pick" || phase.kind === "reading" ? (
          <div className="flex flex-col gap-12">
            <label className="flex flex-col gap-4 text-text-13" htmlFor={`${id}-files`}>
              <span className="font-medium">{t("intake.files")}</span>
              <input
                id={`${id}-files`}
                type="file"
                multiple
                accept="application/pdf,text/plain,image/png,image/jpeg,image/webp"
                onChange={(e) => setFiles([...(e.target.files ?? [])])}
              />
              <span className="text-text-secondary">
                {t("intake.filesHelp", { max: MAX_INTAKE_FILES })}
              </span>
            </label>
            <InboxPicker t={t} messages={inbox} picked={messages} onChange={setMessages} multiple />
            <p className="m-0 text-text-12 text-text-secondary" data-testid="intake-allowance">
              {left === null
                ? t("intake.allowanceLoading")
                : left.left === null
                  ? t("intake.allowanceUnlimited", { count: total })
                  : t("intake.allowance", { count: total, left: left.left })}
            </p>
            {total > MAX_INTAKE_FILES ? (
              <InlineAlert tone="warning">
                {t("intake.tooMany", { max: MAX_INTAKE_FILES })}
              </InlineAlert>
            ) : null}
            {tooBig ? <InlineAlert tone="warning">{t("intake.tooBig")}</InlineAlert> : null}
            <p className="m-0 text-text-12 text-text-secondary">{t("intake.itineraries.sent")}</p>
            {phase.kind === "reading" ? (
              <p role="status" className="m-0 text-text-13 text-text-secondary">
                {t("intake.reading", { done: phase.done + 1, total: phase.total })}
              </p>
            ) : null}
          </div>
        ) : null}
        {phase.kind === "review" ? (
          <div className="flex flex-col gap-12">
            <AiGenerated model={phase.model} />
            <p className="m-0 text-text-12 text-text-secondary">{t("intake.itineraries.review")}</p>
            {rows.length === 0 ? (
              <InlineAlert tone="info">{t("intake.nothingRead")}</InlineAlert>
            ) : null}
            <ul
              className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
              aria-label={t("intake.itineraries.rows")}
            >
              {rows.map((r, i) => (
                <li
                  key={r.suggestionId}
                  className="flex flex-col gap-8 py-8"
                  data-testid="itinerary-row"
                >
                  <Checkbox
                    label={t("intake.itineraries.include", {
                      passenger: r.passenger || t("intake.unread"),
                      from: r.departsFrom,
                      to: r.arrivesAtPlace,
                    })}
                    checked={r.include}
                    onChange={(e) => set(i, { include: e.currentTarget.checked })}
                  />
                  <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
                    <Select
                      label={t("intake.itineraries.traveler")}
                      value={r.personId}
                      options={options(r)}
                      error={r.include && !r.personId ? t("intake.required") : ""}
                      onChange={(e) => set(i, { personId: e.target.value })}
                    />
                    <Input
                      label={t("intake.itineraries.departsLocal")}
                      type="datetime-local"
                      value={r.departsLocal}
                      onChange={(e) => set(i, { departsLocal: e.target.value })}
                    />
                    <Input
                      label={t("intake.itineraries.departsZone")}
                      value={r.departsZone}
                      onChange={(e) => set(i, { departsZone: e.target.value })}
                    />
                    <Input
                      label={t("intake.itineraries.departsFrom")}
                      value={r.departsFrom}
                      onChange={(e) => set(i, { departsFrom: e.target.value })}
                    />
                    <Input
                      label={t("intake.itineraries.arrivesLocal")}
                      type="datetime-local"
                      value={r.arrivesLocal}
                      onChange={(e) => set(i, { arrivesLocal: e.target.value })}
                    />
                    <Input
                      label={t("intake.itineraries.arrivesZone")}
                      value={r.arrivesZone}
                      onChange={(e) => set(i, { arrivesZone: e.target.value })}
                    />
                  </div>
                  <span className="flex flex-wrap gap-4">
                    {r.booked ? (
                      <Tag tone="warning">{t("intake.itineraries.flags.already_booked")}</Tag>
                    ) : null}
                    {(live[i] ?? []).map((f) => (
                      <Tag
                        key={f}
                        tone={
                          f === "inferred_zone" || f === "inferred_year" ? "neutral" : "warning"
                        }
                      >
                        {t(`intake.itineraries.flags.${f}`)}
                      </Tag>
                    ))}
                  </span>
                  {r.excerpt ? (
                    <p className="m-0 text-text-12 text-text-secondary">
                      {t("intake.excerpt", { excerpt: r.excerpt })}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {phase.kind === "added" ? (
          <InlineAlert tone="success">
            {t("intake.itineraries.added", { count: phase.count })}
          </InlineAlert>
        ) : null}
      </AiPanel>
    </>
  );
}
