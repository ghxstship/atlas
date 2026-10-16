"use client";

import type {
  AssertionRank,
  GateCriterion,
  GateEvidence,
  Phase,
  PhaseTransition,
} from "@xos/data/projects";
import {
  AssertionRankBadge,
  Board,
  Button,
  Dialog,
  Input,
  InlineAlert,
  PhaseChip,
  Select,
  Tag,
  Textarea,
  type RecordState,
} from "@xos/ui";
import type { Route } from "next";
import { useFormatter, useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  attestEvidenceAction,
  passGateAction,
  withdrawEvidenceAction,
} from "@/lib/projects/actions";
import { phaseCode } from "@/lib/projects/format";
import { ActionError, echoed, fieldError, useClosingAction } from "./action-error";
import { CollectionViews } from "@/components/views/collection-views";
import { CanonTerm } from "@/components/help/canon-term";

import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
type GateView = "list" | "board";

interface Hidden {
  readonly org: string;
  readonly projectKey: string;
}

function HiddenFields({ org, projectKey }: Hidden) {
  return (
    <>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="projectKey" value={projectKey} />
    </>
  );
}

/**
 * The Gates tab (Section 4.5.4): the nine gates with their canon criteria, the evidence on the one
 * evidence spine, blocking flags, the pass action for the current gate and the transition history.
 * The database decides every pass (invariant 9); a refusal names the missing criteria.
 */
export function GatesView({
  org,
  projectKey,
  phases,
  criteria,
  evidence,
  transitions,
  ranks,
  currentGate,
  canAttest,
  canPass,
  views,
  view,
}: Hidden & {
  phases: readonly Phase[];
  criteria: readonly GateCriterion[];
  evidence: readonly GateEvidence[];
  transitions: readonly PhaseTransition[];
  ranks: readonly AssertionRank[];
  currentGate: number | null;
  canAttest: boolean;
  canPass: boolean;
  views: readonly GateView[];
  view: GateView;
}) {
  const t = useTranslations("projects");
  const format = useFormatter();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const counted = (c: GateCriterion) => evidence.some((e) => e.criterionId === c.id && e.rank >= 1);
  const passedGates = new Map(transitions.map((x) => [x.gate, x]));
  const phaseName = (code: string) => t(`phases.${phaseCode(code)}`);
  const status = (gate: number) =>
    passedGates.has(gate) ? "passed" : gate === currentGate ? "current" : "upcoming";

  const setView = (v: string) => {
    const q = new URLSearchParams(params.toString());
    q.set("view", v);
    router.replace(`${pathname}?${q.toString()}` as Route);
  };

  return (
    <div className="flex flex-col gap-16">
      {views.length > 1 ? (
        <CollectionViews
          label={t("views.label")}
          value={view}
          options={views.map((v) => ({ value: v, label: t(`views.${v}`) }))}
          onChange={setView}
        />
      ) : null}
      {!canAttest && !canPass ? <InlineAlert tone="info">{t("gates.readOnly")}</InlineAlert> : null}

      {view === "board" ? (
        <section aria-label={t("gates.boardLabel")}>
          <Board
            readOnly
            columns={phases.map((ph) => ({
              state: (status(ph.gate) === "passed"
                ? "complete"
                : status(ph.gate) === "current"
                  ? "active"
                  : "proposed") as RecordState,
              label: `${t("gates.gate", { gate: ph.gate })} · ${phaseName(ph.code)}`,
              cards: criteria
                .filter((c) => c.gate === ph.gate)
                .map((c) => ({
                  key: c.id,
                  title: c.statement,
                  meta: `${c.id} · ${c.blocking ? t("gates.blocking") : t("gates.advisory")} · ${
                    counted(c) ? t("gates.met") : t("gates.gap")
                  }`,
                })),
            }))}
          />
        </section>
      ) : (
        <ol
          aria-label={t("gates.listLabel", { key: projectKey })}
          className="m-0 flex list-none flex-col gap-16 p-0"
        >
          {phases.map((ph) => {
            const s = status(ph.gate);
            const own = criteria.filter((c) => c.gate === ph.gate);
            const open = own.filter((c) => c.blocking && !counted(c)).length;
            const next = phases.find((p) => p.gate === ph.gate + 1);
            const passed = passedGates.get(ph.gate);
            return (
              <li key={ph.code}>
                <section
                  aria-labelledby={`gate-${ph.gate}`}
                  className={`flex flex-col gap-12 rounded-card border p-16 ${
                    s === "current" ? "border-accent" : "border-border-subtle"
                  } bg-bg-surface`}
                >
                  <header className="flex flex-wrap items-center justify-between gap-8">
                    <h2
                      id={`gate-${ph.gate}`}
                      className="m-0 flex items-center gap-8 text-heading-16 font-semibold"
                    >
                      <CanonTerm
                        term={phaseName(ph.code)}
                        definition={ph.definition}
                        detail={ph.gateExit}
                      >
                        <PhaseChip
                          gate={ph.gate}
                          code={phaseCode(ph.code)}
                          name={phaseName(ph.code)}
                        />
                      </CanonTerm>
                      <Tag
                        tone={s === "passed" ? "success" : s === "current" ? "accent" : "neutral"}
                      >
                        {t(`gates.${s}`)}
                      </Tag>
                    </h2>
                    {s === "current" && canPass ? (
                      <PassGateDialog
                        org={org}
                        projectKey={projectKey}
                        gate={ph.gate}
                        phaseCode={ph.code}
                        title={
                          next
                            ? t("gates.passTitle", { gate: ph.gate, next: phaseName(next.code) })
                            : t("gates.passTitleLast", { gate: ph.gate })
                        }
                      />
                    ) : null}
                  </header>
                  <p className="m-0 text-text-13 text-text-secondary">
                    <span className="font-medium text-text-primary">{t("gates.exit")}:</span>{" "}
                    {ph.gateExit}
                  </p>
                  {passed ? (
                    <p className="m-0 text-text-13 text-text-secondary">
                      {t("gates.passedOn", {
                        date: format.dateTime(new Date(passed.at), { dateStyle: "medium" }),
                        by: passed.actor
                          ? t("overview.by", { name: passed.actor })
                          : t("overview.system"),
                      })}
                      {" · "}
                      {passed.reason}
                    </p>
                  ) : s === "current" ? (
                    <p className="m-0 text-text-13" role="status">
                      {open > 0 ? t("gates.blockedBy", { count: open }) : t("gates.ready")}
                    </p>
                  ) : null}
                  <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
                    {own.map((c) => {
                      const items = evidence.filter((e) => e.criterionId === c.id);
                      return (
                        <li key={c.id} className="flex flex-col gap-8 py-12">
                          <div className="flex flex-wrap items-start justify-between gap-8">
                            <div className="flex min-w-0 flex-col gap-4">
                              <span className="flex flex-wrap items-center gap-6">
                                <span className="font-mono text-text-12 text-text-secondary">
                                  {c.id}
                                </span>
                                <Tag
                                  tone={
                                    c.blocking ? (counted(c) ? "neutral" : "danger") : "neutral"
                                  }
                                >
                                  {c.blocking ? t("gates.blocking") : t("gates.advisory")}
                                </Tag>
                                <Tag tone={counted(c) ? "success" : "warning"}>
                                  {counted(c) ? t("gates.met") : t("gates.gap")}
                                </Tag>
                              </span>
                              <span className="text-text-14 text-text-primary">{c.statement}</span>
                            </div>
                            {canAttest && s !== "passed" ? (
                              <AttestDialog
                                org={org}
                                projectKey={projectKey}
                                criterion={c}
                                ranks={ranks}
                              />
                            ) : null}
                          </div>
                          {items.length > 0 ? (
                            <ul
                              aria-label={t("gates.evidence")}
                              className="m-0 flex list-none flex-col gap-6 ps-16"
                            >
                              {items.map((e) => (
                                <EvidenceItem
                                  key={e.id}
                                  org={org}
                                  projectKey={projectKey}
                                  evidence={e}
                                  canWithdraw={canAttest && s !== "passed"}
                                />
                              ))}
                            </ul>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              </li>
            );
          })}
        </ol>
      )}

      <section aria-labelledby="gate-history" className="flex flex-col gap-8">
        <h2 id="gate-history" className="m-0 text-heading-16 font-semibold">
          {t("gates.history")}
        </h2>
        {transitions.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("gates.noHistory")}</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-6 p-0 text-text-13">
            {transitions.map((x) => (
              <li key={x.id}>
                <span className="font-medium">
                  {x.toPhaseCode
                    ? t("gates.historyEntry", {
                        gate: x.gate,
                        from: phaseName(x.fromPhaseCode),
                        to: phaseName(x.toPhaseCode),
                      })
                    : t("gates.historyEntryLast", {
                        gate: x.gate,
                        from: phaseName(x.fromPhaseCode),
                      })}
                </span>{" "}
                <span className="text-text-secondary">
                  {x.actor ? t("overview.by", { name: x.actor }) : t("overview.system")} ·{" "}
                  {format.dateTime(new Date(x.at), { dateStyle: "medium" })} · {x.reason}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function EvidenceItem({
  org,
  projectKey,
  evidence,
  canWithdraw,
}: Hidden & { evidence: GateEvidence; canWithdraw: boolean }) {
  const t = useTranslations("projects");
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useClosingAction(withdrawEvidenceAction, () => setOpen(false));
  const isLink = evidence.uri?.startsWith("https://") ?? false;
  return (
    <li className="flex flex-wrap items-center gap-8 text-text-13">
      <AssertionRankBadge
        rank={evidence.rank as 0 | 1 | 2 | 3 | 4}
        label={t("gates.rank", { rank: evidence.rank })}
      />
      {isLink ? (
        <a
          href={evidence.uri ?? ""}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-accent-text underline"
        >
          {evidence.uri}
        </a>
      ) : (
        <span className="font-mono text-text-12">{evidence.uri}</span>
      )}
      {evidence.note ? <span className="text-text-secondary">{evidence.note}</span> : null}
      <span className="text-text-12 text-text-tertiary">
        {evidence.attestedBy
          ? t("overview.by", { name: evidence.attestedBy })
          : t("overview.system")}{" "}
        · {format.dateTime(new Date(evidence.attestedAt), { dateStyle: "medium" })}
      </span>
      {canWithdraw ? (
        <Dialog
          open={open}
          onOpenChange={setOpen}
          trigger={
            <Button size="sm" variant="ghost">
              {t("gates.withdraw")}
            </Button>
          }
          title={t("gates.withdrawAction")}
          description={t("gates.withdrawConfirm")}
          actions={
            <>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                {t("gates.cancel")}
              </Button>
              <Button
                type="submit"
                form={`withdraw-${evidence.id}`}
                variant="danger"
                loading={pending}
              >
                {t("gates.withdrawAction")}
              </Button>
            </>
          }
        >
          <form id={`withdraw-${evidence.id}`} action={action} onSubmit={keepInputOnSubmit(action)}>
            <HiddenFields org={org} projectKey={projectKey} />
            <input type="hidden" name="evidenceId" value={evidence.id} />
            <ActionError state={state} />
          </form>
        </Dialog>
      ) : null}
    </li>
  );
}

function AttestDialog({
  org,
  projectKey,
  criterion,
  ranks,
}: Hidden & { criterion: GateCriterion; ranks: readonly AssertionRank[] }) {
  const t = useTranslations("projects");
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useClosingAction(attestEvidenceAction, () => setOpen(false));
  const id = `attest-${criterion.id.replace(/\./g, "-")}`;
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button
          size="sm"
          variant="secondary"
          aria-label={t("gates.attestFor", { criterion: criterion.id })}
        >
          {t("gates.attest")}
        </Button>
      }
      title={t("gates.attestFor", { criterion: criterion.id })}
      description={criterion.statement}
      actions={
        <>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("gates.cancel")}
          </Button>
          <Button type="submit" form={id} variant="primary" loading={pending}>
            {t("gates.submitEvidence")}
          </Button>
        </>
      }
    >
      <form
        id={id}
        action={action}
        onSubmit={keepInputOnSubmit(action)}
        className="flex flex-col gap-12"
        noValidate
      >
        <HiddenFields org={org} projectKey={projectKey} />
        <input type="hidden" name="criterionId" value={criterion.id} />
        <ActionError state={state} />
        <Input
          id={`${id}-uri`}
          name="uri"
          required
          width="100%"
          defaultValue={echoed(state, "uri")}
          label={t("gates.uri")}
          help={t("gates.uriHelp")}
          error={fieldError(t, state, "uri")}
        />
        <Textarea
          id={`${id}-note`}
          name="note"
          maxLength={2000}
          width="100%"
          defaultValue={echoed(state, "note")}
          label={t("gates.note")}
          error={fieldError(t, state, "note")}
        />
        <Select
          id={`${id}-rank`}
          name="rank"
          label={t("gates.rankLabel")}
          help={t("gates.rankHelp")}
          value={echoed(state, "rank", String(ranks[0]?.rank ?? 4))}
          options={ranks.map((r) => ({
            value: String(r.rank),
            label: t("gates.rankOption", { rank: r.rank, meaning: r.meaning }),
          }))}
        />
      </form>
    </Dialog>
  );
}

function PassGateDialog({
  org,
  projectKey,
  gate,
  phaseCode: code,
  title,
}: Hidden & { gate: number; phaseCode: string; title: string }) {
  const t = useTranslations("projects");
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useClosingAction(passGateAction, () => setOpen(false));
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="primary" size="sm">
          {t("gates.pass", { gate })}
        </Button>
      }
      title={title}
      description={t("gates.passDescription")}
      actions={
        <>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("gates.cancel")}
          </Button>
          <Button type="submit" form="pass-gate" variant="primary" loading={pending}>
            {t("gates.passSubmit")}
          </Button>
        </>
      }
    >
      <form
        id="pass-gate"
        action={action}
        onSubmit={keepInputOnSubmit(action)}
        className="flex flex-col gap-12"
        noValidate
      >
        <HiddenFields org={org} projectKey={projectKey} />
        <input type="hidden" name="expectedPhase" value={code} />
        <ActionError state={state} />
        <Textarea
          id="pass-gate-reason"
          name="reason"
          required
          maxLength={500}
          width="100%"
          defaultValue={echoed(state, "reason")}
          label={t("gates.passReason")}
          help={t("gates.passReasonHelp")}
          error={fieldError(t, state, "reason")}
        />
      </form>
    </Dialog>
  );
}
