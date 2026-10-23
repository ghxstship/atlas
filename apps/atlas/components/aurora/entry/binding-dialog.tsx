"use client";

import type { AuroraCodeBinding } from "@xos/ai/client";
import { Button, InlineAlert, Input, Select } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import {
  bindingCandidatesAction,
  bindScanAction,
  type Candidate,
} from "@/lib/aurora/binding-actions";
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
import type { BindingEntryProps } from "./binding-entry";

type Phase =
  | { readonly kind: "compose" }
  | { readonly kind: "searching" }
  | { readonly kind: "sending" }
  | { readonly kind: "done"; readonly outcome: Outcome<AuroraCodeBinding> }
  | { readonly kind: "binding" };

/**
 * Suggest binding (Section 4.7 mapping help, Section 3.9, A95). The person says what the label
 * says, finds catalog candidates, and sees what Aurora receives: the code, their words and the
 * candidates' names and URIDs, nothing else. Aurora picks one candidate or answers NO ANSWER; the
 * person may choose another candidate and rename it, then "Bind and resolve" writes the catalog
 * binding and resolves the scan. "Discard" rejects the suggestion and leaves the scan open.
 */
export function BindingDialog({
  org,
  scan,
  open,
  onOpenChange,
}: BindingEntryProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useEntryT();
  const id = useId();
  const router = useRouter();
  const { client, availability, check } = useAurora("mapping", open);
  const [description, setDescription] = useState("");
  const [candidates, setCandidates] = useState<readonly Candidate[] | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "compose" });
  const [choice, setChoice] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState<{ tone: "danger" | "warning"; text: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const search = async () => {
    setPhase({ kind: "searching" });
    setMessage(null);
    const query = description.trim() === "" ? scan.code : description.trim();
    const found = await bindingCandidatesAction({ org, query });
    setPhase({ kind: "compose" });
    if (!found.ok) {
      setMessage({ tone: "danger", text: t("binding.searchFailed") });
      return;
    }
    setCandidates(found.candidates);
    setAnnouncement(t("binding.found", { count: found.candidates.length }));
  };

  const send = async () => {
    if (!candidates || candidates.length === 0) return;
    setPhase({ kind: "sending" });
    setAnnouncement(t("sending"));
    const outcome = outcomeOf(
      await client.bindCode({
        code: scan.code,
        description: description.trim() === "" ? null : description.trim(),
        candidates: candidates.map((c) => ({
          element_id: c.elementId,
          name: c.name,
          urid: c.urid,
        })),
      }),
    );
    if (outcome.kind === "answer") {
      setChoice(outcome.answer.elementId);
      setName(outcome.answer.name);
    }
    setPhase({ kind: "done", outcome });
    setAnnouncement(outcomeAnnouncement(outcome, t, t("binding.ready")));
  };

  const answer = phase.kind === "done" && phase.outcome.kind === "answer" ? phase.outcome : null;
  const suggestionId = answer?.suggestions[0]?.suggestion_id ?? null;

  const bind = async () => {
    if (!suggestionId) return;
    setPhase({ kind: "binding" });
    const result = await bindScanAction({
      org,
      scanId: scan.id,
      suggestionId,
      elementId: choice,
      name: name.trim(),
      code: scan.code,
    });
    if (result.ok) {
      onOpenChange(false);
      setAnnouncement(t("binding.bound", { code: scan.code, name: name.trim() }));
      router.refresh();
      return;
    }
    if (answer) setPhase({ kind: "done", outcome: answer });
    setMessage({
      tone: result.stage === "resolution" ? "warning" : "danger",
      text:
        result.stage === "resolution"
          ? t("binding.boundNotResolved", { rule: result.rule ?? "" })
          : t("binding.notBound", { rule: result.rule ?? "" }),
    });
    if (result.stage === "resolution") router.refresh();
  };

  const discard = async () => {
    if (suggestionId) await client.reject(suggestionId, t("binding.discardReason"));
    onOpenChange(false);
    setAnnouncement(t("binding.discarded"));
  };

  const ready = availability.kind === "ready";
  const chosen = candidates?.find((c) => c.elementId === choice);

  return (
    <>
      <LiveRegion message={announcement} />
      <AiPanel
        title={t("binding.title", { code: scan.code })}
        open={open}
        onOpenChange={onOpenChange}
        footer={
          answer ? (
            <>
              <Button variant="ghost" onClick={() => void discard()}>
                {t("discard")}
              </Button>
              <Button
                variant="primary"
                loading={phase.kind === "binding"}
                disabled={!chosen || name.trim() === "" || phase.kind === "binding"}
                onClick={() => void bind()}
              >
                {t("binding.bind")}
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
                  !ready || !candidates || candidates.length === 0 || phase.kind === "sending"
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
            <p className="m-0 text-text-13">
              {t("binding.proposal", {
                name: answer.answer.name,
                urid: answer.answer.urid,
                percent: Math.round(answer.answer.confidence * 100),
              })}
            </p>
            <p className="m-0 text-text-12 text-text-secondary">
              {t("binding.reason", { reason: answer.answer.reason })}
            </p>
            <Select
              id={`${id}-element`}
              label={t("binding.element")}
              value={choice}
              options={(candidates ?? []).map((c) => ({
                value: c.elementId,
                label: `${c.name} (${c.urid})`,
              }))}
              onChange={(e) => {
                setChoice(e.target.value);
                setName(candidates?.find((c) => c.elementId === e.target.value)?.name ?? name);
              }}
            />
            <Input
              id={`${id}-name`}
              label={t("binding.name")}
              help={t("binding.nameHelp")}
              width="100%"
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {message ? <InlineAlert tone={message.tone}>{message.text}</InlineAlert> : null}
          </div>
        ) : (
          <div className="flex flex-col gap-12">
            <Input
              id={`${id}-code`}
              label={t("binding.code")}
              width="100%"
              value={`${scan.code} (${scan.symbology})`}
              readOnly
            />
            <div className="flex flex-wrap items-end gap-8">
              <Input
                id={`${id}-description`}
                label={t("binding.description")}
                help={t("binding.descriptionHelp")}
                width="100%"
                maxLength={300}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              <Button
                variant="secondary"
                icon="Search"
                loading={phase.kind === "searching"}
                disabled={phase.kind === "searching"}
                onClick={() => void search()}
              >
                {t("binding.search")}
              </Button>
            </div>
            {candidates !== null && candidates.length === 0 ? (
              <InlineAlert tone="info">{t("binding.noCandidates")}</InlineAlert>
            ) : null}
            <SentList
              items={[
                { label: t("binding.sentCode"), value: scan.code },
                {
                  label: t("binding.sentDescription"),
                  value:
                    description.trim() === "" ? t("binding.noDescription") : description.trim(),
                },
                {
                  label: t("binding.sentCandidates"),
                  value:
                    candidates === null
                      ? t("binding.searchFirst")
                      : candidates.map((c) => `${c.name} (${c.urid})`).join("\n") ||
                        t("binding.none"),
                },
              ]}
            />
            {message ? <InlineAlert tone={message.tone}>{message.text}</InlineAlert> : null}
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
