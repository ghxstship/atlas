"use client";

import type { AuroraAdvanceAnswers, AuroraPreviewRecord, AuroraProblem } from "@xos/ai/client";
import { Button, InlineAlert, Input, Select, Tag, Textarea } from "@xos/ui";
import { useFormatter } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import type { AdvanceDraftEntryProps } from "./intake-entry";
import { fileSource, MAX_FILE_BYTES, ProblemAlert } from "./intake-shared";
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

type Decision = "accepted" | "rejected";
type Answer = AuroraAdvanceAnswers["answers"][number];

const FILE_SOURCE = "file";

/**
 * Draft Answers from a Reply (B15, parity gap G-173; ADR 0154 D1). One source, verified mail of the
 * project's inbox or a file the person chose, becomes proposed answers for the recipient's open
 * sections. Each is accepted or rejected on its own; accepting records it for the recipient, so
 * someone else reviews it. Verified only means the sender's DKIM passed, so the sender always shows.
 */
export function AdvanceAnswersDialog({
  recipientId,
  recipientName,
  inbox,
  open,
  onOpenChange,
}: AdvanceDraftEntryProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useEntryT();
  const id = useId();
  const format = useFormatter();
  const router = useRouter();
  const { client, availability, check } = useAurora("drafting", open);
  const [source, setSource] = useState(inbox[0]?.id ?? FILE_SOURCE);
  const [file, setFile] = useState<File | null>(null);
  const [records, setRecords] = useState<readonly AuroraPreviewRecord[] | "loading" | "error">(
    "loading",
  );
  const [phase, setPhase] = useState<
    | { kind: "compose" }
    | { kind: "sending" }
    | { kind: "done"; outcome: Outcome<AuroraAdvanceAnswers> }
  >({ kind: "compose" });
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [quantities, setQuantities] = useState<Record<string, number[]>>({});
  const [decided, setDecided] = useState<Record<string, Decision>>({});
  const [problem, setProblem] = useState<AuroraProblem | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const fromMail = source !== FILE_SOURCE;

  // What is sent, shown before the person sends it: the open sections, and the mail when it is mail.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void client
      .preview({
        feature: "drafting",
        draft_kind: "advance_answers",
        advance_recipient_id: recipientId,
        ...(fromMail ? { inbound_message_id: source } : {}),
        items: [],
      })
      .then((r) => {
        if (!live) return;
        if (r.ok) {
          setRecords(r.data.records);
          setProblem(null);
        } else {
          setRecords("error");
          setProblem(r.problem);
        }
      });
    return () => {
      live = false;
    };
  }, [open, client, recipientId, source, fromMail]);

  const send = async () => {
    setPhase({ kind: "sending" });
    setAnnouncement(t("sending"));
    const outcome = outcomeOf(
      await client.draftAdvanceAnswers({
        advance_recipient_id: recipientId,
        ...(fromMail ? { inbound_message_id: source } : await fileSource(file as File)),
      }),
    );
    if (outcome.kind === "answer") {
      setTexts(Object.fromEntries(outcome.answer.answers.map((a) => [a.section_id, a.text ?? ""])));
      setQuantities(
        Object.fromEntries(
          outcome.answer.answers.map((a) => [a.section_id, a.lines.map((l) => l.quantity ?? 0)]),
        ),
      );
    }
    setPhase({ kind: "done", outcome });
    setAnnouncement(outcomeAnnouncement(outcome, t, t("intake.advanceDraft.ready")));
  };

  const accept = async (answer: Answer) => {
    if (!answer.suggestion_id) return;
    setProblem(null);
    const result = await client.applyAdvanceAnswer({
      suggestion_id: answer.suggestion_id,
      values:
        answer.kind === "Text"
          ? { text: texts[answer.section_id] ?? "" }
          : {
              lines: answer.lines.map((line, i) =>
                line.choice_id
                  ? { ...line, quantity: quantities[answer.section_id]?.[i] ?? line.quantity }
                  : line,
              ),
            },
    });
    if (!result.ok) return setProblem(result.problem);
    setDecided((d) => ({ ...d, [answer.section_id]: "accepted" }));
    setAnnouncement(t("intake.advanceDraft.accepted", { section: answer.section_title }));
    router.refresh();
  };

  const reject = async (answer: Answer) => {
    if (!answer.suggestion_id) return;
    const result = await client.reject(answer.suggestion_id, t("intake.rejectReason"));
    if (!result.ok) return setProblem(result.problem);
    setDecided((d) => ({ ...d, [answer.section_id]: "rejected" }));
  };

  const answer = phase.kind === "done" && phase.outcome.kind === "answer" ? phase.outcome : null;
  const titleOf = (sectionId: string) =>
    answer?.answer.sections.find((s) => s.id === sectionId)?.title ?? "";
  const choiceOf = (a: Answer, choiceId: string | undefined) =>
    answer?.answer.sections
      .find((s) => s.id === a.section_id)
      ?.choices.find((c) => c.id === choiceId)?.name ?? "";
  const when = (iso: string | undefined) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" }) : "";
  const message = inbox.find((m) => m.id === source);
  const tooBig = file !== null && file.size > MAX_FILE_BYTES;

  return (
    <>
      <LiveRegion message={announcement} />
      <AiPanel
        title={t("intake.advanceDraft.title", { name: recipientName })}
        open={open}
        onOpenChange={onOpenChange}
        footer={
          answer ? (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
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
                  availability.kind !== "ready" ||
                  phase.kind === "sending" ||
                  records === "error" ||
                  tooBig ||
                  (!fromMail && file === null)
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
            <p className="m-0 text-text-13">{t("intake.advanceDraft.secondPerson")}</p>
            <ul
              className="m-0 flex list-none flex-col gap-12 p-0"
              aria-label={t("intake.advanceDraft.answers")}
            >
              {answer.answer.answers.map((a) => {
                const decision = decided[a.section_id];
                return (
                  <li
                    key={a.section_id}
                    data-testid="advance-answer-card"
                    className="flex flex-col gap-8 rounded-control border border-border-subtle p-8"
                  >
                    <h3 className="m-0 text-text-13 font-semibold">{a.section_title}</h3>
                    {a.kind === "Text" ? (
                      <Textarea
                        id={`${id}-t-${a.section_id}`}
                        label={t("intake.advanceDraft.answer")}
                        width="100%"
                        rows={4}
                        disabled={decision !== undefined}
                        value={texts[a.section_id] ?? ""}
                        onChange={(e) =>
                          setTexts((v) => ({ ...v, [a.section_id]: e.target.value }))
                        }
                      />
                    ) : (
                      <ul className="m-0 flex list-none flex-col gap-4 p-0">
                        {a.lines.map((line, i) => (
                          <li key={i} className="flex flex-wrap items-center gap-8 text-text-13">
                            {line.choice_id ? (
                              <Input
                                id={`${id}-q-${a.section_id}-${i}`}
                                label={choiceOf(a, line.choice_id)}
                                inputMode="numeric"
                                disabled={decision !== undefined}
                                value={String(quantities[a.section_id]?.[i] ?? "")}
                                onChange={(e) => {
                                  const value = Number(e.target.value);
                                  setQuantities((q) => ({
                                    ...q,
                                    [a.section_id]: (q[a.section_id] ?? []).map((n, j) =>
                                      j === i ? value : n,
                                    ),
                                  }));
                                }}
                              />
                            ) : (
                              <span>
                                {t("intake.advanceDraft.window", {
                                  start: when(line.needed_window_start),
                                  end: when(line.needed_window_end),
                                  zone: line.window_zone ?? "",
                                })}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="m-0 text-text-12 text-text-secondary">
                      {t("extract.confidence", { percent: Math.round(a.confidence * 100) })}{" "}
                      {t("extract.source", { excerpt: a.source_excerpt })}
                    </p>
                    <p className="m-0 text-text-12 text-text-secondary">
                      {answer.answer.source.kind === "Project Inbox"
                        ? t("intake.advanceDraft.fromSender", {
                            from: answer.answer.source.from_address,
                          })
                        : t("intake.advanceDraft.fromFile", {
                            name: answer.answer.source.file_name,
                          })}
                    </p>
                    {a.excerpt_checked ? null : (
                      <p className="m-0 text-text-12 text-text-secondary">
                        {t("intake.advanceDraft.checkFile")}
                      </p>
                    )}
                    {decision ? (
                      <Tag tone={decision === "accepted" ? "success" : "neutral"}>
                        {t(`intake.advanceDraft.decision.${decision}`)}
                      </Tag>
                    ) : (
                      <div className="flex flex-wrap gap-8">
                        <Button variant="secondary" size="sm" onClick={() => void accept(a)}>
                          {t("intake.advanceDraft.accept")}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void reject(a)}>
                          {t("intake.advanceDraft.reject")}
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {answer.answer.dropped.length > 0 ? (
              <InlineAlert tone="warning">
                {t("intake.advanceDraft.dropped", { count: answer.answer.dropped.length })}
              </InlineAlert>
            ) : null}
            {answer.answer.unanswered.length > 0 ? (
              <section
                className="flex flex-col gap-4"
                aria-label={t("intake.advanceDraft.unanswered")}
              >
                <h3 className="m-0 text-text-13 font-semibold">
                  {t("intake.advanceDraft.unanswered")}
                </h3>
                <ul className="m-0 flex list-disc flex-col gap-2 ps-16 text-text-12">
                  {answer.answer.unanswered.map((u) => (
                    <li key={u.section_id}>
                      {titleOf(u.section_id)}: {u.missing}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-12">
            <Select
              id={`${id}-source`}
              label={t("intake.advanceDraft.source")}
              value={source}
              options={[
                ...inbox.map((m) => ({
                  value: m.id,
                  label: t("intake.advanceDraft.mailOption", {
                    subject: m.subject ?? t("intake.advanceDraft.noSubject"),
                    from: m.fromAddress,
                  }),
                })),
                { value: FILE_SOURCE, label: t("intake.advanceDraft.fileOption") },
              ]}
              onChange={(e) => setSource(e.target.value)}
            />
            {inbox.length === 0 ? (
              <p className="m-0 text-text-12 text-text-secondary" data-testid="advance-empty-inbox">
                {t("intake.advanceDraft.emptyInbox")}
              </p>
            ) : null}
            {message ? (
              <p className="m-0 text-text-12 text-text-secondary">
                {t("intake.advanceDraft.fromSender", { from: message.fromAddress })}
              </p>
            ) : null}
            {fromMail ? null : (
              <label className="flex flex-col gap-4 text-text-13" htmlFor={`${id}-file`}>
                <span className="font-medium">{t("intake.advanceDraft.file")}</span>
                <input
                  id={`${id}-file`}
                  type="file"
                  accept="application/pdf,text/plain,image/png,image/jpeg,image/webp"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
            )}
            {tooBig ? <InlineAlert tone="warning">{t("intake.tooBig")}</InlineAlert> : null}
            <SentList
              items={[
                { label: t("intake.sentKind"), value: t("intake.advanceDraft.kind") },
                ...(fromMail
                  ? []
                  : [
                      {
                        label: t("intake.sentFiles"),
                        value: file ? file.name : t("intake.noFiles"),
                      },
                    ]),
              ]}
              records={records}
              recordLabel={(r) =>
                r.collection === "inbound-messages"
                  ? t("intake.advanceDraft.mailRecord")
                  : String((r.data as { title?: unknown } | null)?.title ?? r.collection)
              }
              vocabularyTerms={0}
            />
            {phase.kind === "done" ? <OutcomeNotice outcome={phase.outcome} /> : null}
          </div>
        )}
      </AiPanel>
    </>
  );
}
