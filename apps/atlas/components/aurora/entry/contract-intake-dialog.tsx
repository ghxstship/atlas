"use client";

import type {
  AuroraCandidate,
  AuroraContractGroup,
  AuroraProblem,
  AuroraSuggestion,
} from "@xos/ai/client";
import { groupByAct } from "@xos/ai/intake";
import { Button, Checkbox, InlineAlert, Select, Tag } from "@xos/ui";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import type { ContractIntakeEntryProps } from "./intake-entry";
import {
  fileSource,
  formatMinor,
  MAX_FILE_BYTES,
  MAX_INTAKE_FILES,
  ProblemAlert,
  textOf,
  useRequestsLeft,
} from "./intake-shared";
import {
  AiGenerated,
  AiPanel,
  AvailabilityNotice,
  LiveRegion,
  useAurora,
  useEntryT,
} from "./shared";

type FileKind = "contract" | "intake_rider";

interface Picked {
  readonly file: File;
  readonly kind: FileKind;
}

/** One file's read: a contract, or a rider with its lines. */
interface Item {
  readonly act: string;
  readonly contract: AuroraSuggestion | null;
  readonly rider: AuroraSuggestion | null;
  readonly lines: readonly AuroraSuggestion[];
  readonly candidates: readonly AuroraCandidate[];
}

interface Group {
  readonly act: string;
  readonly include: boolean;
  readonly items: readonly Item[];
  readonly personId: string;
  readonly counterpartyId: string;
  readonly bookedId: string | null;
}

type Phase =
  | { readonly kind: "pick" }
  | { readonly kind: "reading"; readonly done: number; readonly total: number }
  | { readonly kind: "review"; readonly batchId: string; readonly model: string | null }
  | { readonly kind: "booked"; readonly engagements: number; readonly riders: number };

const statusOf = (g: Group): "booked" | "new" | "party" | "error" => {
  if (g.bookedId) return "booked";
  const contract = g.items.find((i) => i.contract)?.contract;
  if (!g.personId && !g.counterpartyId) return "party";
  if (!contract || textOf(contract, "start_date") === "") return "error";
  return "new";
};

/**
 * Import contracts and riders with Aurora (B15, parity gap G-177), following P3's import review.
 * Each file is read as one metered request into an intake batch; the rows are grouped by act. An
 * act already booked on the project takes its riders; a new act becomes an Artist engagement at
 * Onboarding with the party the person picks and the role, classification, pay basis and
 * arrangement they set for the batch, never proposed (ADR 0154). The fee shows only to someone who
 * may see pay rates. "Book acts" writes every kept act in one transaction, or nothing.
 */
export function ContractIntakeDialog({
  projectId,
  terms,
  readsPayroll,
  open,
  onOpenChange,
}: ContractIntakeEntryProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useEntryT();
  const locale = useLocale();
  const id = useId();
  const router = useRouter();
  const { client, availability, check } = useAurora("extraction", open);
  const left = useRequestsLeft(client, open);
  const [picked, setPicked] = useState<Picked[]>([]);
  // One canon rate card row for the whole batch, so the four always name a row that exists.
  const [term, setTerm] = useState(terms[0]?.value ?? "");
  const [role = "", classification = "", payBasis = "", arrangement = ""] = term.split("|");
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [groups, setGroups] = useState<Group[]>([]);
  const [problem, setProblem] = useState<AuroraProblem | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const ready = availability.kind === "ready";
  const tooBig = picked.some((p) => p.file.size > MAX_FILE_BYTES);

  const read = async () => {
    setProblem(null);
    const started = await client.startIntake({
      project_id: projectId,
      kind: "Contracts and Riders",
      file_count: picked.length,
    });
    if (!started.ok) return setProblem(started.problem);
    const batchId = started.data.id;
    const reads: { kind: FileKind; ids: string[]; candidates: AuroraCandidate[] }[] = [];
    let model: string | null = null;
    for (const [i, p] of picked.entries()) {
      setPhase({ kind: "reading", done: i, total: picked.length });
      setAnnouncement(t("intake.reading", { done: i + 1, total: picked.length }));
      const result = await client.extract({
        kind: p.kind,
        intake_batch_id: batchId,
        ...(await fileSource(p.file)),
      });
      if (!result.ok) {
        setProblem(result.problem);
        continue;
      }
      model = result.data.model ?? model;
      reads.push({
        kind: p.kind,
        ids: result.data.suggestions.map((s) => s.suggestion_id),
        candidates: [...(result.data.answer?.candidates ?? [])],
      });
    }
    const batch = await client.getIntake(batchId);
    if (!batch.ok) return setProblem(batch.problem);
    const byId = new Map(batch.data.suggestions.map((s) => [s.id, s]));
    const items: Item[] = reads.flatMap((r) => {
      const [first, ...rest] = r.ids
        .map((x) => byId.get(x))
        .filter((s): s is NonNullable<typeof s> => s !== undefined);
      if (!first) return [];
      return [
        {
          act: textOf(first, "act_name"),
          contract: r.kind === "contract" ? first : null,
          rider: r.kind === "intake_rider" ? first : null,
          lines: r.kind === "intake_rider" ? rest : [],
          candidates: r.candidates,
        },
      ];
    });
    setGroups(
      groupByAct(items, (i) => i.act).map((g) => {
        const candidates = g.items.flatMap((i) => i.candidates);
        const booked =
          candidates.find((c) => c.candidate_kind === "engagement")?.candidate_id ?? null;
        return {
          act: g.label || t("intake.unread"),
          include: true,
          items: g.items,
          personId: candidates.find((c) => c.candidate_kind === "person")?.candidate_id ?? "",
          counterpartyId:
            candidates.find((c) => c.candidate_kind === "counterparty")?.candidate_id ?? "",
          bookedId: booked,
        };
      }),
    );
    setPhase({ kind: "review", batchId, model });
    setAnnouncement(t("intake.contracts.ready"));
  };

  const kept = groups.filter(
    (g) => g.include && statusOf(g) !== "party" && statusOf(g) !== "error",
  );
  const book = async (batchId: string) => {
    setProblem(null);
    const payload: AuroraContractGroup[] = kept.map((g) => {
      const contract = g.items.find((i) => i.contract)?.contract;
      const riders = g.items
        .filter((i) => i.rider)
        .map((i) => ({
          header_suggestion_id: i.rider?.id ?? "",
          line_suggestion_ids: i.lines.map((l) => l.id),
        }));
      return {
        act_name: g.act,
        engagement: g.bookedId
          ? { mode: "existing" as const, engagement_id: g.bookedId }
          : {
              mode: "new" as const,
              ...(contract ? { contract_suggestion_id: contract.id } : {}),
              values: {
                ...(g.personId ? { person_id: g.personId } : {}),
                ...(g.counterpartyId ? { counterparty_id: g.counterpartyId } : {}),
                role_code: role,
                worker_classification: classification,
                pay_basis: payBasis,
                arrangement,
              },
            },
        riders,
      };
    });
    const result = await client.applyContracts(batchId, payload);
    if (!result.ok) return setProblem(result.problem);
    setPhase({ kind: "booked", engagements: result.data.engagements, riders: result.data.riders });
    setAnnouncement(
      t("intake.contracts.booked", { count: result.data.engagements, riders: result.data.riders }),
    );
    router.refresh();
  };

  const set = (i: number, patch: Partial<Group>) =>
    setGroups((current) => current.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  const choices = (g: Group, kind: "person" | "counterparty") => [
    {
      value: "",
      label: t(kind === "person" ? "intake.contracts.noPerson" : "intake.contracts.noAccount"),
    },
    ...g.items
      .flatMap((i) => i.candidates)
      .filter(
        (c, k, all) =>
          c.candidate_kind === kind &&
          all.findIndex((x) => x.candidate_id === c.candidate_id) === k,
      )
      .map((c) => ({
        value: c.candidate_id ?? "",
        label: t("intake.candidate", { name: c.name ?? "" }),
      })),
  ];

  return (
    <>
      <LiveRegion message={announcement} />
      <AiPanel
        title={t("intake.contracts.title")}
        open={open}
        onOpenChange={onOpenChange}
        footer={
          phase.kind === "review" ? (
            <>
              <Button
                variant="ghost"
                onClick={() =>
                  void client.closeIntake(phase.batchId).then(() => onOpenChange(false))
                }
              >
                {t("discard")}
              </Button>
              <Button
                variant="primary"
                disabled={kept.length === 0 || term === ""}
                onClick={() => void book(phase.batchId)}
              >
                {t("intake.contracts.book", { count: kept.length })}
              </Button>
            </>
          ) : phase.kind === "booked" ? (
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
                  picked.length === 0 ||
                  picked.length > MAX_INTAKE_FILES ||
                  tooBig ||
                  phase.kind === "reading"
                }
                onClick={() => void read()}
              >
                {t("intake.read", { count: picked.length })}
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
                onChange={(e) =>
                  setPicked(
                    [...(e.target.files ?? [])].map((file) => ({
                      file,
                      kind: /rider/i.test(file.name) ? "intake_rider" : "contract",
                    })),
                  )
                }
              />
              <span className="text-text-secondary">
                {t("intake.filesHelp", { max: MAX_INTAKE_FILES })}
              </span>
            </label>
            {picked.map((p, i) => (
              <Select
                key={`${p.file.name}-${i}`}
                label={t("intake.contracts.fileKind", { name: p.file.name })}
                value={p.kind}
                options={[
                  { value: "contract", label: t("intake.contracts.kinds.contract") },
                  { value: "intake_rider", label: t("intake.contracts.kinds.intake_rider") },
                ]}
                onChange={(e) =>
                  setPicked((all) =>
                    all.map((x, j) => (j === i ? { ...x, kind: e.target.value as FileKind } : x)),
                  )
                }
              />
            ))}
            <Select
              label={t("intake.contracts.defaults")}
              value={term}
              options={terms.map((x) => ({ value: x.value, label: x.label }))}
              onChange={(e) => setTerm(e.target.value)}
            />
            <p className="m-0 text-text-12 text-text-secondary">
              {t("intake.contracts.defaultsHelp")}
            </p>
            <p className="m-0 text-text-12 text-text-secondary" data-testid="intake-allowance">
              {left === null
                ? t("intake.allowanceLoading")
                : left.left === null
                  ? t("intake.allowanceUnlimited", { count: picked.length })
                  : t("intake.allowance", { count: picked.length, left: left.left })}
            </p>
            <p className="m-0 text-text-12 text-text-secondary">
              {readsPayroll ? t("intake.contracts.sentFee") : t("intake.contracts.sentNoFee")}
            </p>
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
            <p className="m-0 text-text-12 text-text-secondary">{t("intake.contracts.review")}</p>
            <ul
              className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
              aria-label={t("intake.contracts.rows")}
            >
              {groups.map((g, i) => {
                const status = statusOf(g);
                const contract = g.items.find((x) => x.contract)?.contract ?? null;
                const fee = contract ? textOf(contract, "fee_minor") : "";
                const currency = contract ? textOf(contract, "currency_code") || "USD" : "USD";
                return (
                  <li
                    key={`${g.act}-${i}`}
                    className="flex flex-col gap-8 py-8"
                    data-testid="contract-group"
                  >
                    <span className="flex flex-wrap items-center gap-8">
                      <Checkbox
                        label={g.act}
                        checked={g.include}
                        onChange={(e) => set(i, { include: e.currentTarget.checked })}
                      />
                      <Tag
                        tone={
                          status === "new" ? "accent" : status === "booked" ? "neutral" : "warning"
                        }
                      >
                        {t(`intake.contracts.status.${status}`)}
                      </Tag>
                    </span>
                    <span className="text-text-12 text-text-secondary">
                      {[
                        t("intake.contracts.dates", {
                          start: (contract && textOf(contract, "start_date")) || t("intake.unread"),
                          end: (contract && textOf(contract, "end_date")) || t("intake.unread"),
                        }),
                        ...(readsPayroll && contract
                          ? [
                              t("intake.contracts.fee", {
                                fee: fee
                                  ? formatMinor(Number(fee), currency, locale)
                                  : t("intake.unread"),
                              }),
                            ]
                          : []),
                        t("intake.contracts.riders", {
                          count: g.items.filter((x) => x.rider).length,
                        }),
                      ].join(" · ")}
                    </span>
                    {g.bookedId ? null : (
                      <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
                        <Select
                          label={t("intake.contracts.person")}
                          value={g.personId}
                          options={choices(g, "person")}
                          onChange={(e) => set(i, { personId: e.target.value })}
                        />
                        <Select
                          label={t("intake.contracts.account")}
                          value={g.counterpartyId}
                          options={choices(g, "counterparty")}
                          onChange={(e) => set(i, { counterpartyId: e.target.value })}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        {phase.kind === "booked" ? (
          <InlineAlert tone="success">
            {t("intake.contracts.booked", { count: phase.engagements, riders: phase.riders })}
          </InlineAlert>
        ) : null}
      </AiPanel>
    </>
  );
}
