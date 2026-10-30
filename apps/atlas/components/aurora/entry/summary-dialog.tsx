"use client";

import type { AuroraPreviewRecord, AuroraSummary } from "@xos/ai/client";
import { Button, InlineAlert, Radio, Tag, Textarea } from "@xos/ui";
import { useEffect, useId, useState } from "react";
import { projectSummaryItemsAction } from "@/lib/aurora/summary-actions";
import {
  AiGenerated,
  AiPanel,
  AvailabilityNotice,
  LiveRegion,
  OutcomeNotice,
  outcomeAnnouncement,
  outcomeOf,
  SentList,
  useAurora,
  useEntryT,
  type Outcome,
} from "./shared";
import type { SummaryEntryProps, SummaryItem, SummaryKind } from "./summary-entry";

type Items =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | {
      readonly kind: "ready";
      readonly items: readonly SummaryItem[];
      readonly window: { readonly from: string; readonly to: string } | null;
      readonly truncated: boolean;
    };

type Phase =
  | { readonly kind: "compose" }
  | { readonly kind: "sending" }
  | { readonly kind: "done"; readonly outcome: Outcome<AuroraSummary> };

/** The summary as editable text: the headline, then one line per point. */
export function summaryText(summary: AuroraSummary): string {
  return [summary.headline, ...summary.bullets.map((b) => `- ${b.text}`)].join("\n");
}

/**
 * Summaries with Aurora (Section 4.7, A95): a record's activity, a project's week or its gate
 * readiness. Before sending, the panel lists every item Aurora receives as aurora.preview reads it;
 * the summary comes back with each point citing the items it rests on, as text the person can edit
 * and copy. A summary writes nothing.
 */
export function SummaryDialog({
  subject,
  kinds,
  items: given,
  project,
  use,
  open,
  onOpenChange,
}: SummaryEntryProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useEntryT();
  const id = useId();
  const { client, availability, check } = useAurora("summaries", open);
  const projectOrg = project?.org;
  const projectKey = project?.key;
  /** A kind's items: known from the page, read for a project (loading), or none. */
  const itemsOf = (k: SummaryKind): Items => {
    const known = given?.[k];
    if (known) return { kind: "ready", items: known, window: null, truncated: false };
    if (projectOrg && projectKey && k !== "record_activity") return { kind: "loading" };
    return { kind: "ready", items: [], window: null, truncated: false };
  };
  // Each opening mounts a fresh panel (useEntryPanel keys it), starting from the first kind.
  const [kind, setKind] = useState<SummaryKind>(kinds[0] ?? "record_activity");
  const [items, setItems] = useState<Items>(() => itemsOf(kinds[0] ?? "record_activity"));
  const [records, setRecords] = useState<readonly AuroraPreviewRecord[] | "loading" | "error">(
    "loading",
  );
  const [phase, setPhase] = useState<Phase>({ kind: "compose" });
  const [text, setText] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [copied, setCopied] = useState(false);

  const choose = (next: SummaryKind) => {
    setKind(next);
    setItems(itemsOf(next));
    setRecords("loading");
    setPhase({ kind: "compose" });
  };

  // A project's items are read when its kind is chosen: the week's activity on its calendar.
  const loading = items.kind === "loading";
  useEffect(() => {
    if (!open || !loading || !projectOrg || !projectKey || kind === "record_activity") return;
    let live = true;
    void projectSummaryItemsAction({ org: projectOrg, projectKey, kind }).then(
      (r) => {
        if (live) setItems(r.ok ? { kind: "ready", ...r } : { kind: "error" });
      },
      () => {
        if (live) setItems({ kind: "error" });
      },
    );
    return () => {
      live = false;
    };
  }, [open, loading, kind, projectOrg, projectKey]);

  // What those items send, read and scrubbed as the summary request would read them.
  useEffect(() => {
    if (!open || items.kind !== "ready") return;
    let live = true;
    void client
      .preview({
        feature: "summaries",
        kind,
        subject_collection: subject.collection,
        subject_id: subject.id,
        items: items.items.map(({ collection, id: rid }) => ({ collection, id: rid })),
      })
      .then((r) => {
        if (live) setRecords(r.ok ? r.data.records : "error");
      });
    return () => {
      live = false;
    };
  }, [open, items, client, kind, subject.collection, subject.id]);

  const labels = new Map<string, string>([
    [subject.id, subject.label],
    ...(items.kind === "ready" ? items.items.map((i) => [i.id, i.label] as const) : []),
  ]);

  const send = async () => {
    if (items.kind !== "ready") return;
    setPhase({ kind: "sending" });
    setAnnouncement(t("sending"));
    const outcome = outcomeOf(
      await client.summarize({
        kind,
        subject_collection: subject.collection,
        subject_id: subject.id,
        items: items.items.map(({ collection, id: rid }) => ({ collection, id: rid })),
      }),
    );
    if (outcome.kind === "answer") setText(summaryText(outcome.answer));
    setPhase({ kind: "done", outcome });
    setAnnouncement(outcomeAnnouncement(outcome, t, t("summary.ready")));
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setAnnouncement(t("summary.copied"));
    } catch {
      setAnnouncement(t("summary.copyFailed"));
    }
  };

  const answer = phase.kind === "done" && phase.outcome.kind === "answer" ? phase.outcome : null;
  const ready = availability.kind === "ready" && items.kind === "ready" && records !== "error";

  return (
    <>
      <LiveRegion message={announcement} />
      <AiPanel
        title={t("summary.title")}
        open={open}
        onOpenChange={onOpenChange}
        footer={
          answer ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("close")}
              </Button>
              {use ? (
                <>
                  <Button variant="secondary" icon="Copy" onClick={() => void copy()}>
                    {copied ? t("summary.copiedButton") : t("summary.copy")}
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => {
                      use.onUse(text, answer.requestId);
                      onOpenChange(false);
                    }}
                  >
                    {use.label}
                  </Button>
                </>
              ) : (
                <Button variant="primary" icon="Copy" onClick={() => void copy()}>
                  {copied ? t("summary.copiedButton") : t("summary.copy")}
                </Button>
              )}
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
                disabled={!ready || phase.kind === "sending"}
                onClick={() => void send()}
              >
                {t("send")}
              </Button>
            </>
          )
        }
      >
        <AvailabilityNotice availability={availability} onRetry={() => void check()} />
        {answer ? (
          <div className="flex flex-col gap-12">
            <AiGenerated model={answer.model} />
            <section aria-labelledby={`${id}-points`} className="flex flex-col gap-8">
              <h3 id={`${id}-points`} className="m-0 text-text-14 font-semibold">
                {answer.answer.headline}
              </h3>
              <ul className="m-0 flex list-disc flex-col gap-8 ps-20 text-text-13">
                {answer.answer.bullets.map((b, i) => (
                  <li key={i} className="flex flex-col gap-4">
                    <span>{b.text}</span>
                    <span className="flex flex-wrap items-center gap-4 text-text-12 text-text-secondary">
                      {t("summary.from")}
                      {b.citations.map((c) => (
                        <Tag key={c} tone="neutral">
                          {labels.get(c) ?? c}
                        </Tag>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <Textarea
              id={`${id}-text`}
              label={t("summary.edit")}
              help={t("summary.editHelp")}
              width="100%"
              rows={8}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setCopied(false);
              }}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-12">
            {kinds.length > 1 ? (
              <Radio
                label={t("summary.what")}
                name={`${id}-kind`}
                value={kind}
                options={kinds.map((k) => ({ value: k, label: t(`summary.kind.${k}`) }))}
                onChange={(e) => choose(e.target.value as SummaryKind)}
              />
            ) : null}
            {items.kind === "error" ? (
              <InlineAlert tone="danger">{t("summary.itemsError")}</InlineAlert>
            ) : null}
            {items.kind === "ready" && items.items.length === 0 && kind !== "gate_readiness" ? (
              <InlineAlert tone="info">{t("summary.nothing")}</InlineAlert>
            ) : null}
            {items.kind === "ready" && items.truncated ? (
              <InlineAlert tone="info">{t("summary.truncated")}</InlineAlert>
            ) : null}
            <SentList
              items={[
                { label: t("summary.sentKind"), value: t(`summary.kind.${kind}`) },
                { label: t("summary.sentSubject"), value: subject.label },
                ...(items.kind === "ready" && items.window
                  ? [
                      {
                        label: t("summary.sentWindow"),
                        value: t("summary.window", {
                          from: items.window.from,
                          to: items.window.to,
                        }),
                      },
                    ]
                  : []),
              ]}
              records={items.kind === "loading" ? "loading" : records}
              recordLabel={(r) => labels.get(r.id) ?? r.collection}
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
