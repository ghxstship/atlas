"use client";

import type { AuroraDraft, AuroraPreviewRecord } from "@xos/ai/client";
import { Button, InlineAlert, Input, Textarea } from "@xos/ui";
import { useEffect, useId, useMemo, useState } from "react";
import {
  AiGenerated,
  AiPanel,
  AvailabilityNotice,
  fillForm,
  LiveRegion,
  OutcomeNotice,
  outcomeAnnouncement,
  outcomeOf,
  SentList,
  useAurora,
  useEntryT,
  type Outcome,
} from "./shared";
import type { DraftEntryProps } from "./draft-entry";

type Phase =
  | { readonly kind: "compose" }
  | { readonly kind: "sending" }
  | { readonly kind: "done"; readonly outcome: Outcome<AuroraDraft> };

/**
 * Drafting with Aurora (Section 4.7, A95): the person says what the draft should say, sees what
 * Aurora receives (their words, the records named, read and scrubbed by aurora.preview, and the
 * verbiage library), and sends it. The draft comes back as an editable title and body with the facts
 * Aurora could not fill marked as gaps. "Use this draft" only fills the editor's own fields: nothing
 * is saved until the person saves the form.
 */
export function DraftDialog({
  kind,
  form,
  fields,
  context,
  instructionsFrom,
  maxBody,
  open,
  onOpenChange,
}: DraftEntryProps & {
  form: () => HTMLFormElement | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useEntryT();
  const id = useId();
  const { client, availability, check } = useAurora("drafting", open);
  // Each opening mounts a fresh panel (useEntryPanel keys it): the instructions start from the
  // editor's field, and the records are previewed once.
  const [instructions, setInstructions] = useState(() => {
    const seed = instructionsFrom ? form()?.elements.namedItem(instructionsFrom) : null;
    return seed instanceof HTMLInputElement || seed instanceof HTMLTextAreaElement
      ? seed.value
      : "";
  });
  const [records, setRecords] = useState<readonly AuroraPreviewRecord[] | "loading" | "error">(
    "loading",
  );
  const [vocabulary, setVocabulary] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "compose" });
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [announcement, setAnnouncement] = useState("");
  // The records named, compared by value: a caller may pass a new array on every render.
  const itemsKey = JSON.stringify(
    context.map(({ collection, id: rid }) => ({ collection, id: rid })),
  );
  const items = useMemo(
    () => JSON.parse(itemsKey) as { collection: string; id: string }[],
    [itemsKey],
  );

  useEffect(() => {
    if (!open) return;
    let live = true;
    void client.preview({ feature: "drafting", items }).then((r) => {
      if (!live) return;
      setRecords(r.ok ? r.data.records : "error");
      setVocabulary(r.ok ? r.data.vocabulary_terms : 0);
    });
    return () => {
      live = false;
    };
  }, [open, client, items]);

  const ready = availability.kind === "ready";
  const send = async () => {
    setPhase({ kind: "sending" });
    setAnnouncement(t("sending"));
    const outcome = outcomeOf(
      await client.draft({ kind, instructions: instructions.trim(), context: items }),
    );
    if (outcome.kind === "answer") {
      setTitle(outcome.answer.title);
      setBody(outcome.answer.body);
    }
    setPhase({ kind: "done", outcome });
    setAnnouncement(outcomeAnnouncement(outcome, t, t("draft.ready")));
  };

  const use = () => {
    const target = form();
    if (!target) return;
    fillForm(target, { ...(fields.title ? { [fields.title]: title } : {}), [fields.body]: body });
    onOpenChange(false);
    setAnnouncement(t("draft.used"));
    const bodyField = target.elements.namedItem(fields.body);
    if (bodyField instanceof HTMLElement) bodyField.focus();
  };

  const answer = phase.kind === "done" && phase.outcome.kind === "answer" ? phase.outcome : null;
  const tooLong = maxBody !== undefined && body.length > maxBody;
  const recordLabel = (r: AuroraPreviewRecord) =>
    context.find((c) => c.id === r.id)?.label ?? r.collection;

  return (
    <>
      <LiveRegion message={announcement} />
      <AiPanel
        title={t(`draft.title.${kind}`)}
        open={open}
        onOpenChange={onOpenChange}
        footer={
          answer ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("discard")}
              </Button>
              <Button variant="primary" disabled={tooLong || body.trim() === ""} onClick={use}>
                {t("draft.use")}
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
                  (context.length > 0 && records === "error")
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
        {answer ? (
          <div className="flex flex-col gap-12">
            <AiGenerated model={answer.model} />
            <p className="m-0 text-text-12 text-text-secondary">{t("draft.review")}</p>
            {fields.title ? (
              <Input
                id={`${id}-title`}
                label={t("draft.resultTitle")}
                width="100%"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            ) : null}
            <Textarea
              id={`${id}-body`}
              label={t("draft.resultBody")}
              width="100%"
              rows={14}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              error={tooLong ? t("draft.tooLong", { max: maxBody ?? 0 }) : ""}
            />
            {answer.answer.gaps.length > 0 ? (
              <InlineAlert tone="warning" title={t("draft.gapsTitle")}>
                <ul className="m-0 flex list-disc flex-col gap-2 ps-16">
                  {answer.answer.gaps.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </InlineAlert>
            ) : null}
            {answer.answer.verbiageMisses.length > 0 ? (
              <InlineAlert tone="info">
                {t("draft.verbiage", { terms: answer.answer.verbiageMisses.join(", ") })}
              </InlineAlert>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-12">
            <Textarea
              id={`${id}-instructions`}
              label={t("draft.instructions")}
              help={t(`draft.instructionsHelp.${kind}`)}
              width="100%"
              rows={4}
              maxLength={4000}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
            <SentList
              items={[
                { label: t("draft.sentKind"), value: t(`draft.kind.${kind}`) },
                {
                  label: t("draft.sentInstructions"),
                  value:
                    instructions.trim() === "" ? t("draft.noInstructions") : instructions.trim(),
                },
              ]}
              {...(context.length > 0 ? { records } : {})}
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
