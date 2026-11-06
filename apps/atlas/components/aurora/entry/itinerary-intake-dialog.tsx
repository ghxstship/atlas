"use client";

import type { AuroraIntakeOptions, AuroraOpenProposal, AuroraProblem } from "@xos/ai/client";
import { isAreaTimeZone, matchExact, normalizePersonName } from "@xos/ai/intake";
import { zonedInstant } from "@xos/ai/lists";
import { Button, Checkbox, InlineAlert, Input, Select, Tag } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import type { ItineraryEntryProps } from "./intake-entry";
import {
  atConcurrency,
  fieldOf,
  fileSource,
  FileStatusList,
  MAX_FILE_BYTES,
  MAX_INTAKE_FILES,
  ProblemAlert,
  textOf,
  toMajorText,
  toMinor,
  useRequestsLeft,
  type FileStatus,
} from "./intake-shared";
import {
  AiGenerated,
  AiPanel,
  AvailabilityNotice,
  LiveRegion,
  SentList,
  useAurora,
  useEntryT,
} from "./shared";

interface Row {
  readonly id: string;
  readonly keep: boolean;
  readonly passenger: string;
  readonly personId: string;
  readonly mode: string;
  readonly operator: string;
  readonly service: string;
  readonly confirmation: string;
  readonly price: string;
  readonly currency: string;
  readonly from: string;
  readonly fromLocal: string;
  readonly fromZone: string;
  readonly to: string;
  readonly toLocal: string;
  readonly toZone: string;
  readonly confidence: number | null;
  readonly excerpt: string;
  readonly yearInferred: boolean;
}

type Status = "ready" | "needsTraveler" | "needsDetails" | "checkZone" | "alreadyBooked";

const rowOf = (p: AuroraOpenProposal, personId: string): Row => {
  const currency = textOf(p, "currency_code");
  const price = textOf(p, "price_minor");
  return {
    id: p.id,
    keep: true,
    passenger: textOf(p, "passenger_name"),
    personId,
    mode: textOf(p, "travel_mode"),
    operator: textOf(p, "operator_name"),
    service: textOf(p, "service_identifier"),
    confirmation: textOf(p, "confirmation_identifier"),
    price: price === "" ? "" : toMajorText(Number(price), currency || "USD"),
    currency,
    from: textOf(p, "departs_from"),
    fromLocal: textOf(p, "departs_local"),
    fromZone: textOf(p, "departs_time_zone"),
    to: textOf(p, "arrives_at_place"),
    toLocal: textOf(p, "arrives_local"),
    toZone: textOf(p, "arrives_time_zone"),
    confidence:
      fieldOf(p, "departs_local")?.confidence ?? fieldOf(p, "departs_from")?.confidence ?? null,
    excerpt:
      fieldOf(p, "departs_local")?.source_excerpt ??
      fieldOf(p, "departs_from")?.source_excerpt ??
      "",
    yearInferred: textOf(p, "year_inferred") === "true",
  };
};

const instantOf = (local: string, zone: string): string | null => {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(local);
  if (!match || !isAreaTimeZone(zone)) return null;
  return zonedInstant(match[1] as string, match[2] as string, zone);
};

const zoneKey = (place: string, zone: string) => `${place}|${zone}`;

/**
 * Read Itineraries (B15, parity gap G-59). The person picks up to 25 files; each is one metered request
 * about the project, and an intake is its open suggestions, so reopening the panel resumes the review.
 * Each printed name maps to a traveler once, each proposed zone is confirmed once, and a person is
 * preselected only on one exact match. "Add {n} Segments" writes the kept lines in one transaction;
 * untouched lines stay open.
 */
export function ItineraryIntakeDialog({
  projectId,
  fulfillmentId,
  open,
  onOpenChange,
}: ItineraryEntryProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useEntryT();
  const id = useId();
  const router = useRouter();
  const { client, availability, check } = useAurora("extraction", open);
  const left = useRequestsLeft(client, open);
  const [files, setFiles] = useState<File[]>([]);
  const [statuses, setStatuses] = useState<FileStatus[]>([]);
  const [reading, setReading] = useState(false);
  const [options, setOptions] = useState<AuroraIntakeOptions | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());
  const [correcting, setCorrecting] = useState<{ id: string; step: 0 | 1 | 2 } | null>(null);
  const [added, setAdded] = useState<number | null>(null);
  const [problem, setProblem] = useState<AuroraProblem | null>(null);
  const [dropNote, setDropNote] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [model, setModel] = useState<string | null>(null);

  const travelerOf = (name: string, opts: AuroraIntakeOptions) =>
    matchExact(
      normalizePersonName(name),
      opts.travelers.map((c) => ({
        id: c.person_id,
        normalized: normalizePersonName(c.display_name),
      })),
    ) ?? "";

  /** The open lines become the review: a reload lands here without another request. */
  const load = async (opts: AuroraIntakeOptions) => {
    const open = await client.openProposals({
      project_id: projectId,
      operation_id: "travelSegments.create",
    });
    if (!open.ok) return setProblem(open.problem);
    const fresh = open.data.data.map((p) =>
      rowOf(p, travelerOf(textOf(p, "passenger_name"), opts)),
    );
    // A line matching a live segment or an earlier line of the batch starts unchecked.
    const seen = new Set(
      opts.segments.map(
        (s) => `${s.person_id}|${s.service_identifier ?? ""}|${Date.parse(s.departs_at)}`,
      ),
    );
    setRows(
      fresh.map((r) => {
        const at = instantOf(r.fromLocal, r.fromZone);
        const key = `${r.personId}|${r.service}|${at ? Date.parse(at) : ""}`;
        const repeats = r.personId !== "" && at !== null && seen.has(key);
        if (r.personId !== "" && at !== null) seen.add(key);
        return repeats ? { ...r, keep: false } : r;
      }),
    );
  };

  useEffect(() => {
    if (!open) return;
    let live = true;
    void client.intakeOptions({ kind: "itinerary", project_id: projectId }).then(async (o) => {
      if (!live) return;
      if (!o.ok) return setProblem(o.problem);
      setOptions(o.data);
      const resumed = await client.openProposals({
        project_id: projectId,
        operation_id: "travelSegments.create",
      });
      if (live && resumed.ok && resumed.data.data.length > 0) await load(o.data);
    });
    return () => {
      live = false;
    };
    // The panel mounts fresh per opening; project and client do not change while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, client, projectId]);

  const read = async () => {
    if (!options) return;
    setProblem(null);
    setReading(true);
    setStatuses(files.map(() => "waiting"));
    const notes: string[] = [];
    await atConcurrency(files, 2, async (file, i) => {
      setStatuses((s) => s.map((v, j) => (j === i ? "reading" : v)));
      setAnnouncement(t("intake.fileReading", { name: file.name }));
      const result = await client.extract({
        kind: "itinerary",
        project_id: projectId,
        ...(await fileSource(file)),
      });
      const ok = result.ok && result.data.outcome === "answer";
      if (result.ok && result.data.model) setModel(result.data.model);
      if (result.ok && result.data.answer) {
        for (const d of result.data.answer.dropped ?? []) {
          notes.push(t(`intake.itinerary.dropped.${d.reason}`, { file: file.name, line: d.line }));
        }
        if (result.data.answer.too_many) {
          notes.push(
            t("intake.tooManyDropped", { file: file.name, count: result.data.answer.too_many }),
          );
        }
      } else if (!result.ok) {
        setProblem(result.problem);
      }
      setStatuses((s) => s.map((v, j) => (j === i ? (ok ? "read" : "failed") : v)));
    });
    setDropNote(notes.join(" "));
    await load(options);
    setReading(false);
    setAnnouncement(t("intake.itinerary.ready"));
  };

  const set = (rowId: string, patch: Partial<Row>) =>
    setRows((current) => current?.map((r) => (r.id === rowId ? { ...r, ...patch } : r)) ?? null);

  const travelers = useMemo(() => {
    const byPerson = new Map<string, { label: string; engagementId: string | null }>();
    for (const c of options?.travelers ?? []) {
      const known = byPerson.get(c.person_id);
      byPerson.set(c.person_id, {
        label: c.display_name,
        // The engagement is filled only when the person has exactly one on the project.
        engagementId:
          known === undefined
            ? c.engagement_id
            : known.engagementId === c.engagement_id
              ? c.engagement_id
              : (known.engagementId ?? c.engagement_id),
      });
    }
    return [...byPerson.entries()].map(([value, v]) => ({ value, ...v }));
  }, [options]);

  const zones = useMemo(() => {
    const out = new Map<string, { place: string; zone: string }>();
    for (const r of rows ?? []) {
      out.set(zoneKey(r.from, r.fromZone), { place: r.from, zone: r.fromZone });
      out.set(zoneKey(r.to, r.toZone), { place: r.to, zone: r.toZone });
    }
    return [...out.values()].filter((z) => z.place !== "");
  }, [rows]);

  const names = useMemo(
    () => [...new Set((rows ?? []).map((r) => r.passenger).filter((n) => n !== ""))],
    [rows],
  );

  const liveSegments = useMemo(
    () =>
      new Set(
        (options?.segments ?? []).map(
          (s) => `${s.person_id}|${s.service_identifier ?? ""}|${Date.parse(s.departs_at)}`,
        ),
      ),
    [options],
  );

  const statusOf = (r: Row): Status => {
    const at = instantOf(r.fromLocal, r.fromZone);
    if (
      r.personId !== "" &&
      at &&
      liveSegments.has(`${r.personId}|${r.service}|${Date.parse(at)}`)
    ) {
      return "alreadyBooked";
    }
    if (r.personId === "") return "needsTraveler";
    if (r.mode === "" || r.fromLocal === "" || r.from === "" || r.to === "") return "needsDetails";
    if (
      !confirmed.has(zoneKey(r.from, r.fromZone)) ||
      !confirmed.has(zoneKey(r.to, r.toZone)) ||
      !isAreaTimeZone(r.fromZone) ||
      !isAreaTimeZone(r.toZone)
    ) {
      return "checkZone";
    }
    return "ready";
  };

  const kept = (rows ?? []).filter((r) => r.keep);
  const allReady = kept.length > 0 && kept.every((r) => statusOf(r) === "ready");

  const add = async () => {
    setProblem(null);
    const result = await client.applyItinerary({
      project_id: projectId,
      fulfillment_id: fulfillmentId,
      items: kept.map((r) => {
        const engagement = travelers.find((p) => p.value === r.personId)?.engagementId ?? null;
        const priceMinor = r.price === "" ? null : toMinor(r.price, r.currency || "USD");
        return {
          suggestion_id: r.id,
          values: {
            person_id: r.personId,
            ...(engagement ? { engagement_id: engagement } : {}),
            travel_mode: r.mode,
            operator_name: r.operator,
            service_identifier: r.service,
            confirmation_identifier: r.confirmation,
            departs_from: r.from,
            departs_at: instantOf(r.fromLocal, r.fromZone),
            departs_time_zone: r.fromZone,
            arrives_at_place: r.to,
            arrives_at: instantOf(r.toLocal, r.toZone),
            arrives_time_zone: r.toZone,
            price_minor: priceMinor,
            currency_code: priceMinor === null ? null : r.currency,
          },
        };
      }),
    });
    if (!result.ok) return setProblem(result.problem);
    setAdded(result.data.written.length);
    setAnnouncement(t("intake.itinerary.added", { count: result.data.written.length }));
    router.refresh();
  };

  const rejectAll = async () => {
    await Promise.all((rows ?? []).map((r) => client.reject(r.id, t("intake.rejectReason"))));
    onOpenChange(false);
  };

  const editing = correcting ? (rows ?? []).find((r) => r.id === correcting.id) : undefined;
  const totalLeft = left?.left ?? null;
  const tooBig = files.some((f) => f.size > MAX_FILE_BYTES);

  return (
    <>
      <LiveRegion message={announcement} />
      <AiPanel
        title={t("intake.itinerary.title")}
        open={open}
        onOpenChange={onOpenChange}
        footer={
          added !== null ? (
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              {t("close")}
            </Button>
          ) : rows !== null ? (
            <>
              <Button variant="ghost" onClick={() => void rejectAll()}>
                {t("intake.rejectAll")}
              </Button>
              <Button variant="primary" disabled={!allReady} onClick={() => void add()}>
                {t("intake.itinerary.add", { count: kept.length })}
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
                loading={reading}
                disabled={
                  availability.kind !== "ready" ||
                  files.length === 0 ||
                  files.length > MAX_INTAKE_FILES ||
                  tooBig ||
                  reading ||
                  options === null
                }
                onClick={() => void read()}
              >
                {t("send")}
              </Button>
            </>
          )
        }
      >
        <AvailabilityNotice availability={availability} onRetry={() => void check()} />
        <ProblemAlert t={t} problem={problem} />
        {added !== null ? (
          <InlineAlert tone="success">{t("intake.itinerary.added", { count: added })}</InlineAlert>
        ) : rows === null ? (
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
            {files.length > MAX_INTAKE_FILES ? (
              <InlineAlert tone="warning">
                {t("intake.tooMany", { max: MAX_INTAKE_FILES })}
              </InlineAlert>
            ) : null}
            {tooBig ? <InlineAlert tone="warning">{t("intake.tooBig")}</InlineAlert> : null}
            <SentList
              items={[
                { label: t("intake.sentKind"), value: t("intake.itinerary.kind") },
                {
                  label: t("intake.sentFiles"),
                  value:
                    files.length === 0 ? t("intake.noFiles") : files.map((f) => f.name).join(", "),
                },
                { label: t("extract.sentNothingElse"), value: t("extract.nothingElse") },
              ]}
            />
            <p className="m-0 text-text-12 text-text-secondary" data-testid="intake-allowance">
              {totalLeft === null
                ? t("intake.usesUnlimited", { n: files.length })
                : t("intake.uses", { n: files.length, left: totalLeft })}
            </p>
            <p className="m-0 text-text-12 text-text-secondary">{t("intake.keepsNothing")}</p>
            {statuses.length > 0 ? (
              <FileStatusList t={t} files={files} statuses={statuses} />
            ) : null}
          </div>
        ) : editing && correcting ? (
          <div className="flex flex-col gap-12">
            <h3 className="m-0 text-text-13 font-semibold">
              {t(`intake.itinerary.steps.${correcting.step}`)}
            </h3>
            {correcting.step === 0 ? (
              <>
                <Select
                  id={`${id}-mode`}
                  label={t("intake.itinerary.mode")}
                  value={editing.mode}
                  options={[
                    { value: "", label: t("intake.choose") },
                    { value: "Flight", label: t("intake.itinerary.flight") },
                    { value: "Ground", label: t("intake.itinerary.ground") },
                  ]}
                  onChange={(e) => set(editing.id, { mode: e.target.value })}
                />
                <Input
                  id={`${id}-op`}
                  label={t("intake.itinerary.operator")}
                  value={editing.operator}
                  onChange={(e) => set(editing.id, { operator: e.target.value })}
                />
                <Input
                  id={`${id}-svc`}
                  label={t("intake.itinerary.service")}
                  value={editing.service}
                  onChange={(e) => set(editing.id, { service: e.target.value })}
                />
                <Input
                  id={`${id}-cnf`}
                  label={t("intake.itinerary.confirmation")}
                  value={editing.confirmation}
                  onChange={(e) => set(editing.id, { confirmation: e.target.value })}
                />
                <Input
                  id={`${id}-prc`}
                  label={t("intake.itinerary.price")}
                  inputMode="decimal"
                  value={editing.price}
                  onChange={(e) => set(editing.id, { price: e.target.value })}
                />
                <Input
                  id={`${id}-cur`}
                  label={t("intake.itinerary.currency")}
                  value={editing.currency}
                  onChange={(e) => set(editing.id, { currency: e.target.value.toUpperCase() })}
                />
              </>
            ) : correcting.step === 1 ? (
              <>
                <Input
                  id={`${id}-from`}
                  label={t("intake.itinerary.place")}
                  value={editing.from}
                  onChange={(e) => set(editing.id, { from: e.target.value })}
                />
                <Input
                  id={`${id}-fromAt`}
                  type="datetime-local"
                  label={t("intake.itinerary.localTime")}
                  value={editing.fromLocal}
                  onChange={(e) => set(editing.id, { fromLocal: e.target.value })}
                />
                <Input
                  id={`${id}-fromZ`}
                  label={t("intake.itinerary.zone")}
                  value={editing.fromZone}
                  onChange={(e) => set(editing.id, { fromZone: e.target.value })}
                />
              </>
            ) : (
              <>
                <Input
                  id={`${id}-to`}
                  label={t("intake.itinerary.place")}
                  value={editing.to}
                  onChange={(e) => set(editing.id, { to: e.target.value })}
                />
                <Input
                  id={`${id}-toAt`}
                  type="datetime-local"
                  label={t("intake.itinerary.localTime")}
                  value={editing.toLocal}
                  onChange={(e) => set(editing.id, { toLocal: e.target.value })}
                />
                <Input
                  id={`${id}-toZ`}
                  label={t("intake.itinerary.zone")}
                  value={editing.toZone}
                  onChange={(e) => set(editing.id, { toZone: e.target.value })}
                />
              </>
            )}
            <div className="flex flex-wrap gap-8">
              <Button
                variant="secondary"
                onClick={() =>
                  setCorrecting(
                    correcting.step === 2
                      ? null
                      : { id: correcting.id, step: (correcting.step + 1) as 1 | 2 },
                  )
                }
              >
                {correcting.step === 2 ? t("intake.done") : t("intake.next")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-12">
            <AiGenerated model={model} />
            {dropNote ? <InlineAlert tone="warning">{dropNote}</InlineAlert> : null}
            <p className="m-0 text-text-12 text-text-secondary">{t("intake.itinerary.review")}</p>
            {names.length > 0 ? (
              <section
                className="flex flex-col gap-8"
                aria-label={t("intake.itinerary.travelersTitle")}
              >
                <h3 className="m-0 text-text-13 font-semibold">
                  {t("intake.itinerary.travelersTitle")}
                </h3>
                {names.map((name) => (
                  <Select
                    key={name}
                    id={`${id}-map-${name}`}
                    label={t("intake.itinerary.printedAs", { name })}
                    value={(rows ?? []).find((r) => r.passenger === name)?.personId ?? ""}
                    options={[
                      { value: "", label: t("intake.choose") },
                      ...travelers.map((p) => ({ value: p.value, label: p.label })),
                    ]}
                    onChange={(e) =>
                      setRows(
                        (current) =>
                          current?.map((r) =>
                            r.passenger === name ? { ...r, personId: e.target.value } : r,
                          ) ?? null,
                      )
                    }
                  />
                ))}
              </section>
            ) : null}
            {zones.length > 0 ? (
              <section
                className="flex flex-col gap-8"
                aria-label={t("intake.itinerary.zonesTitle")}
              >
                <h3 className="m-0 text-text-13 font-semibold">
                  {t("intake.itinerary.zonesTitle")}
                </h3>
                <p className="m-0 text-text-12 text-text-secondary">
                  {t("intake.itinerary.checkZone")}
                </p>
                {zones.map((z) => {
                  const key = zoneKey(z.place, z.zone);
                  return (
                    <div key={key} className="flex flex-wrap items-end gap-8">
                      <Input
                        id={`${id}-zone-${key}`}
                        label={t("intake.itinerary.zoneOf", { place: z.place })}
                        value={z.zone}
                        error={
                          z.zone !== "" && !isAreaTimeZone(z.zone)
                            ? t("intake.itinerary.badZone")
                            : ""
                        }
                        onChange={(e) => {
                          const value = e.target.value;
                          setRows(
                            (current) =>
                              current?.map((r) => ({
                                ...r,
                                fromZone:
                                  r.from === z.place && r.fromZone === z.zone ? value : r.fromZone,
                                toZone: r.to === z.place && r.toZone === z.zone ? value : r.toZone,
                              })) ?? null,
                          );
                        }}
                      />
                      <Checkbox
                        label={t("intake.itinerary.confirmZone")}
                        checked={confirmed.has(key)}
                        disabled={!isAreaTimeZone(z.zone)}
                        onChange={(e) => {
                          const on = e.currentTarget.checked;
                          setConfirmed((c) => {
                            const next = new Set(c);
                            if (on) next.add(key);
                            else next.delete(key);
                            return next;
                          });
                        }}
                      />
                    </div>
                  );
                })}
              </section>
            ) : null}
            <div className="overflow-x-auto">
              <table
                role="grid"
                aria-label={t("intake.itinerary.linesTitle")}
                className="w-full text-text-13"
              >
                <thead>
                  <tr className="text-left">
                    <th scope="col">{t("intake.keep")}</th>
                    <th scope="col">{t("intake.itinerary.traveler")}</th>
                    <th scope="col">{t("intake.itinerary.route")}</th>
                    <th scope="col">{t("intake.confidence")}</th>
                    <th scope="col">{t("intake.excerpt")}</th>
                    <th scope="col">{t("intake.status")}</th>
                    <th scope="col">{t("intake.correct")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(rows ?? []).map((r) => {
                    const status = statusOf(r);
                    return (
                      <tr key={r.id} data-testid="itinerary-row" className="align-top">
                        <td>
                          <Checkbox
                            label={t("intake.keepLine", { name: r.passenger || r.from })}
                            checked={r.keep}
                            onChange={(e) => set(r.id, { keep: e.currentTarget.checked })}
                          />
                        </td>
                        <td>
                          <Select
                            id={`${id}-p-${r.id}`}
                            label={t("intake.itinerary.traveler")}
                            value={r.personId}
                            options={[
                              { value: "", label: t("intake.choose") },
                              ...travelers.map((p) => ({ value: p.value, label: p.label })),
                            ]}
                            onChange={(e) => set(r.id, { personId: e.target.value })}
                          />
                        </td>
                        <td>
                          <span className="flex flex-col gap-2">
                            <span>
                              {t("intake.itinerary.routeLine", {
                                from: r.from || "-",
                                to: r.to || "-",
                              })}
                            </span>
                            <span className="text-text-12 text-text-secondary">
                              {r.fromLocal} {r.fromZone} / {r.toLocal} {r.toZone}
                            </span>
                            {r.yearInferred ? (
                              <span className="text-text-12 text-text-secondary">
                                {t("intake.itinerary.yearInferred")}
                              </span>
                            ) : null}
                          </span>
                        </td>
                        <td>
                          {r.confidence === null
                            ? ""
                            : t("extract.confidence", { percent: Math.round(r.confidence * 100) })}
                        </td>
                        <td className="text-text-12 text-text-secondary">{r.excerpt}</td>
                        <td>
                          <Tag tone={status === "ready" ? "success" : "warning"}>
                            {t(`intake.itinerary.status.${status}`)}
                          </Tag>
                        </td>
                        <td>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setCorrecting({ id: r.id, step: 0 })}
                          >
                            {t("intake.correct")}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </AiPanel>
    </>
  );
}
