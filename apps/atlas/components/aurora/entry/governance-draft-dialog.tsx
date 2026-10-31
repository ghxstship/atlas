"use client";

import type { AuroraDraft, AuroraPreviewRecord } from "@xos/ai/client";
import { Button, InlineAlert, Input, Textarea } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { saveGovernanceDraftAction } from "@/app/[org]/p/[projectKey]/documents/aurora-actions";
import type { GovernanceDraftEntryProps, GovernanceKind } from "./answers-entry";
import {
  AiGenerated,
  AiPanel,
  AvailabilityNotice,
  LiveRegion,
  OutcomeNotice,
  outcomeOf,
  SentList,
  useAurora,
  useEntryT,
  type Outcome,
} from "./shared";

/** Each kind's outline, as catalog keys under entry.governance.outline (packages/ai OUTLINES). */
const OUTLINES: Readonly<Record<GovernanceKind, readonly string[]>> = {
  event_plan: [
    "overview",
    "schedule",
    "siteAndVenue",
    "staffingAndRoles",
    "safetyAndRisk",
    "medicalAndEmergency",
    "communications",
    "permitsAndApprovals",
  ],
  event_brief: ["purpose", "keyFacts", "scheduleHighlights", "contactsByRole", "whatIsNeeded"],
  approval_pack: [
    "coverLetter",
    "eventSummary",
    "permitsHeldAndPending",
    "insurance",
    "riskSummary",
    "sitePlanAndCapacity",
    "contacts",
  ],
  waste_plan: [
    "wasteStreams",
    "binsAndPlacement",
    "vendorResponsibilities",
    "collectionSchedule",
    "diversionTargets",
    "reporting",
  ],
};

type Phase =
  | { readonly kind: "compose" }
  | { readonly kind: "sending" }
  | { readonly kind: "done"; readonly outcome: Outcome<AuroraDraft> }
  | { readonly kind: "saved" };

/**
 * Draft an event plan, brief, approval pack or waste plan with Aurora (B15, parity gap G-240). The
 * panel shows exactly what is sent (aurora.preview reads the project's records as the draft does),
 * the draft comes back with the outline headings it lacks and the facts the records do not hold as
 * [needs: ...], and "Save to project documents" files it as a Markdown document whose first line is
 * the AI label. Nothing is saved until the person saves it.
 */
export function GovernanceDraftDialog({
  org,
  projectId,
  projectKey,
  projectName,
  kind,
  open,
  onOpenChange,
}: GovernanceDraftEntryProps & {
  kind: GovernanceKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useEntryT();
  const id = useId();
  const router = useRouter();
  const { client, availability, check } = useAurora("drafting", open);
  const outline = OUTLINES[kind].map((k) => t(`governance.outline.${k}`));
  const [instructions, setInstructions] = useState(() =>
    t(`governance.defaultInstructions.${kind}`, { name: projectName }),
  );
  const [records, setRecords] = useState<readonly AuroraPreviewRecord[] | "loading" | "error">(
    "loading",
  );
  const [phase, setPhase] = useState<Phase>({ kind: "compose" });
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const target = { collection: "projects" as const, id: projectId };

  useEffect(() => {
    if (!open) return;
    let live = true;
    void client.preview({ feature: "drafting", draft_kind: kind, target, items: [] }).then((r) => {
      if (live) setRecords(r.ok ? r.data.records : "error");
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the target is the project, fixed for the panel
  }, [open, client, kind, projectId]);

  const send = async () => {
    setPhase({ kind: "sending" });
    const outcome = outcomeOf(
      await client.draft({ kind, instructions: instructions.trim(), target, outline }),
    );
    if (outcome.kind === "answer") {
      setTitle(outcome.answer.title);
      setBody(outcome.answer.body);
    }
    setPhase({ kind: "done", outcome });
    setAnnouncement(outcome.kind === "answer" ? t("governance.ready") : t("noAnswer"));
  };

  const save = async () => {
    setError(null);
    const saved = await saveGovernanceDraftAction({ org, projectId, projectKey, title, body });
    if (!saved.ok) return setError(saved.error);
    setPhase({ kind: "saved" });
    setAnnouncement(t("governance.saved"));
    router.refresh();
  };

  const answer = phase.kind === "done" && phase.outcome.kind === "answer" ? phase.outcome : null;
  const missing = answer ? (answer.answer.missingHeadings ?? []) : [];

  return (
    <>
      <LiveRegion message={announcement} />
      <AiPanel
        title={t(`governance.title.${kind}`)}
        open={open}
        onOpenChange={onOpenChange}
        footer={
          answer ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("discard")}
              </Button>
              <Button
                variant="primary"
                disabled={title.trim() === "" || body.trim() === ""}
                onClick={() => void save()}
              >
                {t("governance.save")}
              </Button>
            </>
          ) : phase.kind === "saved" ? (
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
                  availability.kind !== "ready" ||
                  instructions.trim() === "" ||
                  phase.kind === "sending" ||
                  records === "error"
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
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        {answer ? (
          <div className="flex flex-col gap-12">
            <AiGenerated model={answer.model} />
            <p className="m-0 text-text-12 text-text-secondary">{t("governance.review")}</p>
            <Input
              id={`${id}-title`}
              label={t("draft.resultTitle")}
              width="100%"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Textarea
              id={`${id}-body`}
              label={t("draft.resultBody")}
              width="100%"
              rows={16}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            {missing.length > 0 ? (
              <InlineAlert tone="warning" title={t("governance.missingTitle")}>
                {missing.join(", ")}
              </InlineAlert>
            ) : null}
            {answer.answer.gaps.length > 0 ? (
              <InlineAlert tone="warning" title={t("draft.gapsTitle")}>
                <ul className="m-0 flex list-disc flex-col gap-2 ps-16">
                  {answer.answer.gaps.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </InlineAlert>
            ) : null}
            <p className="m-0 text-text-12 text-text-secondary">{t("governance.labelNote")}</p>
          </div>
        ) : phase.kind === "saved" ? (
          <InlineAlert tone="success">{t("governance.saved")}</InlineAlert>
        ) : (
          <div className="flex flex-col gap-12">
            <Textarea
              id={`${id}-instructions`}
              label={t("draft.instructions")}
              width="100%"
              rows={4}
              maxLength={4000}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
            <SentList
              items={[
                { label: t("draft.sentKind"), value: t(`governance.kinds.${kind}`) },
                { label: t("governance.sentOutline"), value: outline.join(", ") },
              ]}
              records={records}
              recordLabel={(r) => r.collection}
              vocabularyTerms={0}
            />
            {phase.kind === "done" ? <OutcomeNotice outcome={phase.outcome} /> : null}
          </div>
        )}
      </AiPanel>
    </>
  );
}
