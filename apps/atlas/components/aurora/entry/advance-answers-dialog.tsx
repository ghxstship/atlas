"use client";

import type { AuroraAdvanceAnswers, AuroraProblem } from "@xos/ai/client";
import { Button, InlineAlert, Select, Tag } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import type { AdvanceAnswersEntryProps } from "./answers-entry";
import { fileSource, InboxPicker, MAX_FILE_BYTES, ProblemAlert } from "./intake-shared";
import {
  AiGenerated,
  AiPanel,
  AvailabilityNotice,
  LiveRegion,
  OutcomeNotice,
  outcomeOf,
  useAurora,
  useEntryT,
  type Outcome,
} from "./shared";

type Decision = "accepted" | "rejected";

type Phase =
  | { readonly kind: "compose" }
  | { readonly kind: "sending" }
  | { readonly kind: "done"; readonly outcome: Outcome<AuroraAdvanceAnswers> };

/**
 * Draft advance answers with Aurora (B15, parity gap G-173; ADR 0154). The person picks the recipient
 * (when opened from mail) and one source, a verified project inbox message or a document the party
 * sent, and Aurora drafts at most one answer per open section with the words it read. Each answer is
 * accepted on its own and recorded on the party's behalf, so the recorder cannot review it; sections
 * the source does not answer are listed, never invented. Nothing is recorded until Accept.
 */
export function AdvanceAnswersDialog({
  recipients,
  inbox,
  messageId,
  open,
  onOpenChange,
}: AdvanceAnswersEntryProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useEntryT();
  const id = useId();
  const router = useRouter();
  const { client, availability, check } = useAurora("drafting", open);
  const [recipient, setRecipient] = useState(
    recipients.length === 1 ? (recipients[0]?.id ?? "") : "",
  );
  const [message, setMessage] = useState<string[]>(messageId ? [messageId] : []);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "compose" });
  const [decided, setDecided] = useState<Record<string, Decision>>({});
  const [problem, setProblem] = useState<AuroraProblem | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const ready = availability.kind === "ready";
  const source = message[0] ? { inbound_message_id: message[0] } : null;

  const send = async () => {
    setProblem(null);
    setPhase({ kind: "sending" });
    const outcome = outcomeOf(
      await client.draft({
        kind: "advance_answers",
        instructions: t("advanceAnswers.instructions"),
        target: { collection: "advance-recipients", id: recipient },
        source: source ?? { document: await fileSource(file as File) },
      }),
    );
    setPhase({ kind: "done", outcome });
    setAnnouncement(outcome.kind === "answer" ? t("advanceAnswers.ready") : t("noAnswer"));
  };

  const accept = async (suggestionId: string) => {
    setProblem(null);
    const result = await client.applyAdvanceAnswer({
      suggestion_id: suggestionId,
      source: source ?? { file_name: file?.name ?? "" },
    });
    if (!result.ok) return setProblem(result.problem);
    setDecided((d) => ({ ...d, [suggestionId]: "accepted" }));
    setAnnouncement(t("advanceAnswers.accepted"));
    router.refresh();
  };

  const reject = async (suggestionId: string) => {
    const result = await client.reject(suggestionId, t("advanceAnswers.rejectReason"));
    if (!result.ok) return setProblem(result.problem);
    setDecided((d) => ({ ...d, [suggestionId]: "rejected" }));
  };

  const answer = phase.kind === "done" && phase.outcome.kind === "answer" ? phase.outcome : null;
  const lineText = (l: AuroraAdvanceAnswers["answers"][number]["lines"][number]) =>
    l.from_local
      ? t("advanceAnswers.window", {
          from: l.from_local.replace("T", " "),
          to: (l.to_local ?? "").replace("T", " "),
        })
      : t("advanceAnswers.item", {
          quantity: l.quantity ?? 0,
          label: l.label,
          person: l.person_name ?? "",
        });

  return (
    <>
      <LiveRegion message={announcement} />
      <AiPanel
        title={t("advanceAnswers.title")}
        open={open}
        onOpenChange={onOpenChange}
        footer={
          answer ? (
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
                loading={phase.kind === "sending"}
                disabled={
                  !ready ||
                  !recipient ||
                  (!source && !file) ||
                  (file?.size ?? 0) > MAX_FILE_BYTES ||
                  phase.kind === "sending"
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
        <ProblemAlert t={t} problem={problem} />
        {answer ? (
          <div className="flex flex-col gap-12">
            <AiGenerated model={answer.model} />
            <p className="m-0 text-text-12 text-text-secondary">{t("advanceAnswers.review")}</p>
            {answer.answer.answers.map((a) => {
              const state = a.suggestion_id ? decided[a.suggestion_id] : undefined;
              return (
                <article
                  key={a.section_id}
                  className="flex flex-col gap-8 rounded-8 border border-border-subtle p-12"
                  data-testid="drafted-answer"
                >
                  <span className="flex flex-wrap items-center gap-8">
                    <span className="text-text-14 font-medium">{a.section_title}</span>
                    <Tag tone="accent">{t("aiLabel")}</Tag>
                    {state ? (
                      <Tag tone={state === "accepted" ? "success" : "neutral"}>
                        {t(`advanceAnswers.${state}`)}
                      </Tag>
                    ) : null}
                  </span>
                  {a.body ? <p className="m-0 whitespace-pre-wrap text-text-13">{a.body}</p> : null}
                  {a.lines.length > 0 ? (
                    <ul className="m-0 flex list-disc flex-col gap-2 ps-16 text-text-13">
                      {a.lines.map((l, i) => (
                        <li key={i}>{lineText(l)}</li>
                      ))}
                    </ul>
                  ) : a.body ? null : (
                    <p className="m-0 text-text-13 text-text-secondary">
                      {t("advanceAnswers.noLines")}
                    </p>
                  )}
                  {a.dropped.length > 0 ? (
                    <p className="m-0 text-text-12 text-text-secondary">
                      {t("advanceAnswers.dropped", {
                        count: a.dropped.length,
                        choices: a.dropped.flatMap((d) => (d.choice ? [d.choice] : [])).join(", "),
                      })}
                    </p>
                  ) : null}
                  {a.source_excerpt ? (
                    <p className="m-0 text-text-12 text-text-secondary">
                      {t("intake.excerpt", { excerpt: a.source_excerpt })}
                    </p>
                  ) : null}
                  {a.suggestion_id && !state && (a.body || a.lines.length > 0) ? (
                    <span className="flex gap-8">
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => void accept(a.suggestion_id as string)}
                      >
                        {t("advanceAnswers.accept")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void reject(a.suggestion_id as string)}
                      >
                        {t("advanceAnswers.reject")}
                      </Button>
                    </span>
                  ) : null}
                </article>
              );
            })}
            {answer.answer.unanswered.length > 0 ? (
              <InlineAlert tone="info" title={t("advanceAnswers.unansweredTitle")}>
                <ul className="m-0 flex list-disc flex-col gap-2 ps-16">
                  {answer.answer.unanswered.map((u) => (
                    <li key={u.section_id}>{u.title}</li>
                  ))}
                </ul>
              </InlineAlert>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-12">
            {recipients.length > 1 || !recipient ? (
              <Select
                label={t("advanceAnswers.recipient")}
                value={recipient}
                options={[
                  { value: "", label: t("advanceAnswers.pickRecipient") },
                  ...recipients.map((r) => ({ value: r.id, label: r.label })),
                ]}
                onChange={(e) => setRecipient(e.target.value)}
              />
            ) : null}
            <InboxPicker
              t={t}
              messages={inbox}
              picked={message}
              onChange={(ids) => setMessage(ids.slice(-1))}
              multiple={false}
            />
            {message.length === 0 ? (
              <label className="flex flex-col gap-4 text-text-13" htmlFor={`${id}-file`}>
                <span className="font-medium">{t("advanceAnswers.file")}</span>
                <input
                  id={`${id}-file`}
                  type="file"
                  accept="application/pdf,text/plain,image/png,image/jpeg,image/webp"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
            ) : null}
            <p className="m-0 text-text-12 text-text-secondary">{t("advanceAnswers.sent")}</p>
            {phase.kind === "done" ? <OutcomeNotice outcome={phase.outcome} /> : null}
          </div>
        )}
      </AiPanel>
    </>
  );
}
