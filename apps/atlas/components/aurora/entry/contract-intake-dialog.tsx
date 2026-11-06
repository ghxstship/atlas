"use client";

import type {
  AuroraAppliedContracts,
  AuroraContractItem,
  AuroraIntakeOptions,
  AuroraOpenProposal,
  AuroraProblem,
} from "@xos/ai/client";
import {
  FLAT_FEE,
  matchExact,
  normalizeAct,
  normalizePersonName,
  prefilledFee,
} from "@xos/ai/intake";
import { Button, Checkbox, InlineAlert, Input, Select, Tag } from "@xos/ui";
import { useLocale } from "next-intl";
import Link from "next/link";
import type { Route } from "next";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { attachContractFileAction } from "./contract-intake-actions";
import type { ContractIntakeEntryProps } from "./intake-entry";
import {
  atConcurrency,
  fieldOf,
  fileSource,
  FileStatusList,
  formatMinor,
  MAX_FILE_BYTES,
  MAX_INTAKE_FILES,
  minorOf,
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

/** XOS-ENG-4: vendor-supplied labor names the vendor, so it is offered only for a counterparty. */
const VENDOR_SUPPLIED = "VENDOR_SUPPLIED";

interface Group {
  readonly key: string;
  readonly act: string;
  readonly documents: readonly AuroraOpenProposal[];
  readonly keep: boolean;
  /** kind:id of the chosen party, or "". */
  readonly party: string;
  readonly engagementId: string;
  readonly startDate: string;
  readonly endDate: string;
  /** The rate typed, in major units. */
  readonly fee: string;
  readonly currency: string;
}

type Status = "ready" | "needsParty" | "needsStartDate" | "alreadyBooked" | "other";

const typeOf = (p: AuroraOpenProposal) => textOf(p, "document_type") || "Other";

const groupDocuments = (proposals: readonly AuroraOpenProposal[]) => {
  const groups = new Map<string, AuroraOpenProposal[]>();
  for (const p of proposals) {
    const act = textOf(p, "act_name");
    // A document with no act is its own group.
    const key = normalizeAct(act) || `document:${p.id}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups.entries()];
};

/**
 * Read Contracts and Riders (B15, parity gap G-177). Files stay in the browser until they are added.
 * The review groups documents by act, and a party is preselected only on one exact match; Aurora
 * creates no person, account or counterparty. The terms come from one rate card choice, and a fee
 * printed as a total prefills only on a Flat Fee row. "Add {n} Bookings" writes in one transaction,
 * then each file still in memory attaches to its document row, a contract's as Restricted.
 */
export function ContractIntakeDialog({
  projects,
  importHref,
  open,
  onOpenChange,
}: ContractIntakeEntryProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useEntryT();
  const id = useId();
  const locale = useLocale();
  const router = useRouter();
  const params = useParams<{ org: string }>();
  const { client, availability, check } = useAurora("extraction", open);
  const left = useRequestsLeft(client, open);
  const [projectId, setProjectId] = useState(projects.length === 1 ? (projects[0]?.id ?? "") : "");
  const [options, setOptions] = useState<AuroraIntakeOptions | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [statuses, setStatuses] = useState<FileStatus[]>([]);
  const [reading, setReading] = useState(false);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [termKey, setTermKey] = useState("");
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [problem, setProblem] = useState<AuroraProblem | null>(null);
  const [applied, setApplied] = useState<AuroraAppliedContracts | null>(null);
  const [uploads, setUploads] = useState<Record<string, "attached" | "failed" | "pending">>({});
  const [announcement, setAnnouncement] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [dropNote, setDropNote] = useState("");
  // Bytes stay here until a document is added; a resumed review has lost them and offers Attach File.
  const held = useRef(new Map<string, File>());

  const partiesFor = (opts: AuroraIntakeOptions) =>
    opts.parties.map((p) => ({
      id: `${p.kind}:${p.id}`,
      normalized: p.kind === "person" ? normalizePersonName(p.name) : normalizeAct(p.name),
    }));

  const load = async (opts: AuroraIntakeOptions, project: string) => {
    const proposals = await client.openProposals({
      project_id: project,
      operation_id: "engagements.createFromContract",
    });
    if (!proposals.ok) return setProblem(proposals.problem);
    const candidates = partiesFor(opts);
    setGroups(
      groupDocuments(proposals.data.data).map(([key, documents]) => {
        const lead = documents.find((d) => typeOf(d) === "Contract") ?? documents[0];
        const act = lead ? textOf(lead, "act_name") : "";
        const contract = documents.find((d) => typeOf(d) === "Contract");
        return {
          key,
          act,
          documents,
          // Kept only if it can be added: a rider-only group of someone who may not add riders has nothing to add.
          keep: documents.some(
            (d) => typeOf(d) === "Contract" || (typeOf(d) === "Rider" && opts.can_write_riders),
          ),
          party: matchExact(normalizeAct(act), candidates) ?? "",
          engagementId: "",
          startDate: contract ? textOf(contract, "start_date") : "",
          endDate: contract ? textOf(contract, "end_date") : "",
          fee: "",
          currency: contract ? textOf(contract, "agreed_rate_currency_code") : "",
        };
      }),
    );
  };

  useEffect(() => {
    if (!open || projectId === "") return;
    let live = true;
    void client.intakeOptions({ kind: "contract", project_id: projectId }).then(async (o) => {
      if (!live) return;
      if (!o.ok) return setProblem(o.problem);
      setOptions(o.data);
      const resumed = await client.openProposals({
        project_id: projectId,
        operation_id: "engagements.createFromContract",
      });
      if (live && resumed.ok && resumed.data.data.length > 0) await load(o.data, projectId);
    });
    return () => {
      live = false;
    };
    // The client does not change while the panel is open.
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
        kind: "contract",
        project_id: projectId,
        ...(await fileSource(file)),
      });
      const suggestion = result.ok ? result.data.suggestions[0]?.suggestion_id : undefined;
      if (suggestion) held.current.set(suggestion, file);
      if (result.ok && result.data.model) setModel(result.data.model);
      if (!result.ok) setProblem(result.problem);
      if (!result.ok || result.data.outcome === "failed") {
        notes.push(t("intake.fileFailed", { file: file.name }));
      } else if (result.data.outcome === "no_answer") {
        notes.push(t("intake.fileNoAnswer", { file: file.name }));
      }
      setStatuses((s) => s.map((v, j) => (j === i ? (suggestion ? "read" : "failed") : v)));
    });
    setDropNote(notes.join(" "));
    await load(options, projectId);
    setReading(false);
    setAnnouncement(t("intake.contract.ready"));
  };

  const rateCards = useMemo(() => options?.rate_cards ?? [], [options]);
  const keyOf = (c: AuroraIntakeOptions["rate_cards"][number]) =>
    [c.role_code, c.worker_classification, c.pay_basis, c.arrangement].join("|");
  const term = rateCards.find((c) => keyOf(c) === termKey);
  const flatFee = term?.pay_basis === FLAT_FEE;

  const partyOf = (g: Group) => options?.parties.find((p) => `${p.kind}:${p.id}` === g.party);

  const statusOf = (g: Group): Status => {
    // A rider-only group of someone who may not add riders has nothing to add, as an Other document does.
    if (
      !g.documents.some(
        (d) => typeOf(d) === "Contract" || (typeOf(d) === "Rider" && options?.can_write_riders),
      )
    ) {
      return "other";
    }
    if (g.party === "") return "needsParty";
    if ((partyOf(g)?.engagement_ids.length ?? 0) > 0) return "alreadyBooked";
    if (g.startDate === "") return "needsStartDate";
    return "ready";
  };

  const canBook = (g: Group) => {
    const status = statusOf(g);
    const booked = partyOf(g)?.engagement_ids ?? [];
    if (status === "alreadyBooked") return booked.length === 1 || g.engagementId !== "";
    return status === "ready" && term !== undefined && termAllowed(g);
  };
  const termAllowed = (g: Group) =>
    term?.worker_classification !== VENDOR_SUPPLIED || partyOf(g)?.kind === "counterparty";

  const set = (key: string, patch: Partial<Group>) =>
    setGroups((current) => current?.map((g) => (g.key === key ? { ...g, ...patch } : g)) ?? null);

  const kept = (groups ?? []).filter((g) => g.keep);
  const ready = kept.length > 0 && kept.every(canBook);

  /** A fee printed as a total prefills only on a Flat Fee row; otherwise the person types a rate. */
  const printedFee = (g: Group) => {
    const contract = g.documents.find((d) => typeOf(d) === "Contract");
    return contract ? minorOf(contract, "agreed_rate_minor") : null;
  };

  const attach = async (documentId: string, type: string, file: File, suggestionId: string) => {
    setUploads((u) => ({ ...u, [suggestionId]: "pending" }));
    const form = new FormData();
    form.set("org", params.org);
    form.set("engagementDocumentId", documentId);
    form.set("documentType", type);
    form.set("file", file);
    const result = await attachContractFileAction(form).catch(() => ({ ok: false }));
    setUploads((u) => ({ ...u, [suggestionId]: result.ok ? "attached" : "failed" }));
  };

  const add = async () => {
    setProblem(null);
    const items: AuroraContractItem[] = kept.map((g) => {
      const party = partyOf(g);
      const riders = g.documents.some((d) => typeOf(d) === "Rider") && options?.can_write_riders;
      const attachOnly = (party?.engagement_ids.length ?? 0) > 0;
      const currency = g.currency.trim().toUpperCase();
      const feeMinor =
        options?.fee_visible && !attachOnly && g.fee.trim() !== ""
          ? toMinor(g.fee, currency || "USD")
          : null;
      return {
        // A rider the person may not add is left out of the group rather than refused.
        suggestion_ids: g.documents
          .filter((d) => typeOf(d) === "Contract" || (typeOf(d) === "Rider" && riders))
          .map((d) => d.id),
        party:
          party?.kind === "person" ? { person_id: party.id } : { counterparty_id: party?.id ?? "" },
        ...(g.engagementId ? { engagement_id: g.engagementId } : {}),
        ...(attachOnly || !term
          ? {}
          : {
              role_code: term.role_code,
              worker_classification: term.worker_classification,
              pay_basis: term.pay_basis,
              arrangement: term.arrangement,
              start_date: g.startDate,
              ...(g.endDate ? { end_date: g.endDate } : {}),
            }),
        ...(feeMinor !== null ? { agreed_rate_minor: feeMinor, currency_code: currency } : {}),
        create_riders: Boolean(riders),
      };
    });
    const result = await client.applyContractIntake({ project_id: projectId, items });
    if (!result.ok) return setProblem(result.problem);
    setApplied(result.data);
    setAnnouncement(t("intake.contract.added", { count: result.data.engagements.length }));
    const documents = result.data.engagements.flatMap((e) => e.documents);
    await atConcurrency(documents, 2, async (d) => {
      const file = held.current.get(d.suggestion_id);
      if (file && d.engagement_document_id) {
        await attach(d.engagement_document_id, d.document_type, file, d.suggestion_id);
      }
    });
    router.refresh();
  };

  const rejectAll = async () => {
    await Promise.all(
      (groups ?? []).flatMap((g) =>
        g.documents.map((d) => client.reject(d.id, t("intake.rejectReason"))),
      ),
    );
    onOpenChange(false);
  };

  const editing = correcting ? (groups ?? []).find((g) => g.key === correcting) : undefined;
  const tooBig = files.some((f) => f.size > MAX_FILE_BYTES);
  const totalLeft = left?.left ?? null;

  return (
    <>
      <LiveRegion message={announcement} />
      <AiPanel
        title={t("intake.contract.title")}
        open={open}
        onOpenChange={onOpenChange}
        footer={
          applied ? (
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              {t("close")}
            </Button>
          ) : groups !== null ? (
            <>
              <Button variant="ghost" onClick={() => void rejectAll()}>
                {t("intake.rejectAll")}
              </Button>
              <Button variant="primary" disabled={!ready} onClick={() => void add()}>
                {t("intake.contract.add", { count: kept.length })}
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
        {applied ? (
          <div className="flex flex-col gap-8" data-testid="contract-added">
            <InlineAlert tone="success">
              {t("intake.contract.added", { count: applied.engagements.length })}
            </InlineAlert>
            <ul className="m-0 flex list-none flex-col gap-8 p-0">
              {applied.engagements.flatMap((e) =>
                e.documents.flatMap((d) =>
                  d.engagement_document_id
                    ? [
                        <li
                          key={d.suggestion_id}
                          className="flex flex-wrap items-center gap-8 text-text-13"
                        >
                          <Tag tone="neutral">{t(`intake.contract.type.${d.document_type}`)}</Tag>
                          {uploads[d.suggestion_id] ? (
                            <Tag
                              tone={uploads[d.suggestion_id] === "failed" ? "danger" : "success"}
                            >
                              {t(`intake.contract.upload.${uploads[d.suggestion_id] ?? "pending"}`)}
                            </Tag>
                          ) : null}
                          {uploads[d.suggestion_id] !== "attached" &&
                          uploads[d.suggestion_id] !== "pending" ? (
                            <label className="flex flex-col gap-4 text-text-12">
                              <span>{t("intake.contract.attachFile")}</span>
                              <input
                                type="file"
                                accept="application/pdf,text/plain,image/png,image/jpeg,image/webp"
                                onChange={(event) => {
                                  const file = event.target.files?.[0];
                                  if (file && d.engagement_document_id) {
                                    void attach(
                                      d.engagement_document_id,
                                      d.document_type,
                                      file,
                                      d.suggestion_id,
                                    );
                                  }
                                }}
                              />
                            </label>
                          ) : null}
                        </li>,
                      ]
                    : [],
                ),
              )}
            </ul>
          </div>
        ) : groups === null ? (
          <div className="flex flex-col gap-12">
            {projects.length > 1 ? (
              <Select
                id={`${id}-project`}
                label={t("intake.contract.project")}
                value={projectId}
                options={[
                  { value: "", label: t("intake.choose") },
                  ...projects.map((p) => ({ value: p.id, label: p.label })),
                ]}
                onChange={(e) => setProjectId(e.target.value)}
              />
            ) : null}
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
                { label: t("intake.sentKind"), value: t("intake.contract.kind") },
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
        ) : editing ? (
          <div className="flex flex-col gap-12">
            <h3 className="m-0 text-text-13 font-semibold">
              {editing.act || t("intake.contract.noAct")}
            </h3>
            <Input
              id={`${id}-start`}
              type="date"
              label={t("intake.contract.startDate")}
              value={editing.startDate}
              onChange={(e) => set(editing.key, { startDate: e.target.value })}
            />
            <Input
              id={`${id}-end`}
              type="date"
              label={t("intake.contract.endDate")}
              value={editing.endDate}
              onChange={(e) => set(editing.key, { endDate: e.target.value })}
            />
            {options?.fee_visible ? (
              <>
                <Input
                  id={`${id}-fee`}
                  label={t("intake.contract.fee")}
                  inputMode="decimal"
                  value={editing.fee}
                  help={flatFee ? "" : t("intake.contract.feeHint")}
                  onChange={(e) => set(editing.key, { fee: e.target.value })}
                />
                <Input
                  id={`${id}-currency`}
                  label={t("intake.contract.currency")}
                  value={editing.currency}
                  onChange={(e) => set(editing.key, { currency: e.target.value.toUpperCase() })}
                />
              </>
            ) : null}
            <div>
              <Button variant="secondary" onClick={() => setCorrecting(null)}>
                {t("intake.done")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-12">
            <AiGenerated model={model} />
            {dropNote ? <InlineAlert tone="warning">{dropNote}</InlineAlert> : null}
            <p className="m-0 text-text-12 text-text-secondary">{t("intake.contract.review")}</p>
            <Select
              id={`${id}-term`}
              label={t("intake.contract.terms")}
              value={termKey}
              help={t("intake.contract.termsHelp")}
              options={[
                { value: "", label: t("intake.choose") },
                ...rateCards.map((c) => ({
                  value: keyOf(c),
                  label: t("intake.contract.termLabel", {
                    role: c.role_name,
                    classification: c.worker_classification_label,
                    basis: c.pay_basis,
                    arrangement: c.arrangement,
                  }),
                })),
              ]}
              onChange={(e) => {
                const next = e.target.value;
                setTermKey(next);
                const chosen = rateCards.find((c) => keyOf(c) === next);
                // Only a Flat Fee row carries the printed total; any other basis clears it.
                setGroups(
                  (current) =>
                    current?.map((g) => {
                      const fee = prefilledFee(chosen?.pay_basis ?? null, printedFee(g));
                      return { ...g, fee: toMajorText(fee, g.currency || "USD") };
                    }) ?? null,
                );
              }}
            />
            {options?.fee_visible && term && !flatFee ? (
              <InlineAlert tone="info">{t("intake.contract.feeHint")}</InlineAlert>
            ) : null}
            <ul
              className="m-0 flex list-none flex-col gap-12 p-0"
              aria-label={t("intake.contract.groups")}
            >
              {(groups ?? []).map((g) => {
                const status = statusOf(g);
                const party = partyOf(g);
                const printed = printedFee(g);
                return (
                  <li
                    key={g.key}
                    data-testid="contract-group"
                    className="flex flex-col gap-8 rounded-control border border-border-subtle p-8"
                  >
                    <div className="flex flex-wrap items-center gap-8">
                      <Checkbox
                        label={t("intake.keepLine", { name: g.act || t("intake.contract.noAct") })}
                        checked={g.keep}
                        disabled={status === "other"}
                        onChange={(e) => set(g.key, { keep: e.currentTarget.checked })}
                      />
                      <Tag
                        tone={
                          status === "ready" || status === "alreadyBooked" ? "success" : "warning"
                        }
                      >
                        {t(`intake.contract.status.${status}`)}
                      </Tag>
                    </div>
                    {status === "other" ? null : (
                      <Select
                        id={`${id}-party-${g.key}`}
                        label={t("intake.contract.party")}
                        value={g.party}
                        options={[
                          { value: "", label: t("intake.choose") },
                          ...(options?.parties ?? []).map((p) => ({
                            value: `${p.kind}:${p.id}`,
                            label: p.name,
                          })),
                        ]}
                        onChange={(e) => set(g.key, { party: e.target.value, engagementId: "" })}
                      />
                    )}
                    {status === "needsParty" && importHref ? (
                      <Link className="text-text-12 underline" href={importHref as Route}>
                        {t("intake.contract.importCounterparties")}
                      </Link>
                    ) : null}
                    {status === "alreadyBooked" ? (
                      <>
                        <p className="m-0 text-text-12 text-text-secondary">
                          {t("intake.contract.attachOnly")}
                        </p>
                        {(party?.engagement_ids.length ?? 0) > 1 ? (
                          <Select
                            id={`${id}-engagement-${g.key}`}
                            label={t("intake.contract.chooseBooking")}
                            value={g.engagementId}
                            options={[
                              { value: "", label: t("intake.choose") },
                              ...(party?.engagement_ids ?? []).map((value, i) => ({
                                value,
                                label: t("intake.contract.bookingN", { n: i + 1 }),
                              })),
                            ]}
                            onChange={(e) => set(g.key, { engagementId: e.target.value })}
                          />
                        ) : null}
                      </>
                    ) : null}
                    {term?.worker_classification === VENDOR_SUPPLIED && party?.kind === "person" ? (
                      <InlineAlert tone="warning">
                        {t("intake.contract.vendorNeedsCounterparty")}
                      </InlineAlert>
                    ) : null}
                    <dl className="m-0 flex flex-col gap-4 text-text-12">
                      {g.documents.map((d) => (
                        <div key={d.id} className="flex flex-col gap-2">
                          <dt className="flex flex-wrap items-center gap-4">
                            <Tag tone="neutral">{t(`intake.contract.type.${typeOf(d)}`)}</Tag>
                            <span>{textOf(d, "title")}</span>
                          </dt>
                          <dd className="m-0 text-text-secondary">
                            {t("intake.contract.dates", {
                              start: textOf(d, "start_date") || "-",
                              end: textOf(d, "end_date") || "-",
                            })}{" "}
                            {fieldOf(d, "start_date")?.source_excerpt ?? ""}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    {options?.fee_visible && printed !== null ? (
                      <p className="m-0 text-text-12 text-text-secondary" data-testid="printed-fee">
                        {t("intake.contract.printedFee", {
                          fee: formatMinor(printed, g.currency || "USD", locale),
                        })}
                      </p>
                    ) : null}
                    {options?.fee_visible && g.fee !== "" ? (
                      <p className="m-0 text-text-12">
                        {t("intake.contract.rate", { rate: g.fee })}
                      </p>
                    ) : null}
                    <div>
                      <Button variant="ghost" size="sm" onClick={() => setCorrecting(g.key)}>
                        {t("intake.correct")}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </AiPanel>
    </>
  );
}
