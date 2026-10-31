"use client";

import type { RecordReview as Review } from "@xos/data/work";
import { Button, Select, Switch, Tag, Textarea } from "@xos/ui";
import { useState } from "react";
import { updateRecordAction } from "./actions";
import { ActionErrorAlert, useAction, useCopy } from "./action-ui";
import { decideReviewAction, requestReviewAction } from "./review-actions";

/**
 * A record's review (B14, G-268; ADR 0153 D5): the Requires review switch, the latest review with its state and
 * decision, Request review with a reviewer and a note while the record is Active, and Approve or Request changes for
 * the named reviewer and any other eligible approver who is not the requester. Loaded on demand through
 * components/lazy-ui/record-review.tsx, never with the record collection. The database decides every rule.
 */
export function RecordReview({
  org,
  recordId,
  state,
  requiresReview,
  reviews,
  people,
  me,
  canWrite,
  canClearFlag,
}: {
  org: string;
  recordId: string;
  state: string;
  requiresReview: boolean;
  /** Latest first. */
  reviews: readonly Review[];
  people: readonly { readonly personId: string; readonly name: string | null }[];
  me: string | null;
  canWrite: boolean;
  /** projects.settings.write: turning the flag off needs it (record_review_flag_locked). */
  canClearFlag: boolean;
}) {
  const t = useCopy("work");
  const flag = useAction();
  const request = useAction();
  const decide = useAction();
  const [reviewer, setReviewer] = useState("");
  const [note, setNote] = useState("");
  const [answer, setAnswer] = useState("");
  const latest = reviews.find((r) => r.approvalState !== "Canceled") ?? null;
  const open = latest !== null && latest.decision === null;
  const canDecide = canWrite && open && latest.requesterId !== me;
  const decisionLabel = (r: Review) =>
    r.decision === "Approved"
      ? t("review.approved")
      : r.decision === "Rejected"
        ? t("review.changesRequested")
        : t("review.open");

  return (
    <section aria-labelledby={`review-${recordId}`} className="flex flex-col gap-12">
      <h2 id={`review-${recordId}`} className="m-0 text-heading-16 font-semibold">
        {t("review.title")}
      </h2>
      <Switch
        label={t("review.requiresReview")}
        checked={requiresReview}
        disabled={!canWrite || flag.pending || (requiresReview && !canClearFlag)}
        onChange={(e) =>
          flag.run(() => updateRecordAction(org, recordId, { requiresReview: e.target.checked }))
        }
      />
      <p className="m-0 text-text-12 text-text-secondary">
        {requiresReview && !canClearFlag ? t("review.flagLocked") : t("review.requiresReviewHelp")}
      </p>
      <ActionErrorAlert error={flag.error} />

      {latest ? (
        <div className="flex flex-col gap-4 text-text-13" role="status">
          <span className="flex flex-wrap items-center gap-6">
            <Tag
              tone={
                latest.decision === "Approved"
                  ? "success"
                  : latest.decision === "Rejected"
                    ? "warning"
                    : "accent"
              }
            >
              {decisionLabel(latest)}
            </Tag>
            <span>
              {t("review.latest", {
                key: latest.approvalKey,
                reviewer: latest.reviewerName ?? t("review.anyApprover"),
                requester: latest.requesterName ?? t("values.unnamed"),
              })}
            </span>
          </span>
          {latest.decision && latest.approverName ? (
            <span className="text-text-secondary">
              {t("review.decidedBy", { name: latest.approverName })}
            </span>
          ) : null}
        </div>
      ) : (
        <p className="m-0 text-text-13 text-text-secondary">{t("review.none")}</p>
      )}

      {canDecide ? (
        <div className="flex flex-col gap-8">
          <Textarea
            id={`review-answer-${recordId}`}
            label={t("review.answerNote")}
            help={t("review.answerNoteHelp")}
            maxLength={1000}
            width="100%"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <div className="flex flex-wrap gap-8">
            <Button
              type="button"
              variant="primary"
              loading={decide.pending}
              onClick={() =>
                decide.run(() =>
                  decideReviewAction(org, {
                    approvalRecordId: latest.approvalRecordId,
                    decision: "Approved",
                    note: answer || null,
                  }),
                )
              }
            >
              {t("review.approve")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              loading={decide.pending}
              onClick={() =>
                decide.run(() =>
                  decideReviewAction(org, {
                    approvalRecordId: latest.approvalRecordId,
                    decision: "Rejected",
                    note: answer || null,
                  }),
                )
              }
            >
              {t("review.requestChanges")}
            </Button>
          </div>
          <ActionErrorAlert error={decide.error} />
        </div>
      ) : null}

      {canWrite && state === "Active" && !open ? (
        <div className="flex flex-col gap-8">
          <Select
            id={`review-reviewer-${recordId}`}
            label={t("review.reviewer")}
            value={reviewer}
            options={[
              { value: "", label: t("review.anyApprover") },
              ...people
                .filter((p) => p.personId !== me)
                .map((p) => ({ value: p.personId, label: p.name ?? p.personId })),
            ]}
            onChange={(e) => setReviewer(e.target.value)}
          />
          <Textarea
            id={`review-note-${recordId}`}
            label={t("review.note")}
            maxLength={1000}
            width="100%"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div>
            <Button
              type="button"
              variant="secondary"
              loading={request.pending}
              onClick={() =>
                request.run(
                  () =>
                    requestReviewAction(org, {
                      recordId,
                      reviewerId: reviewer || null,
                      note: note || null,
                    }),
                  () => setNote(""),
                )
              }
            >
              {t("review.request")}
            </Button>
          </div>
          <ActionErrorAlert error={request.error} />
        </div>
      ) : null}

      {reviews.length > 1 ? (
        <details className="text-text-13">
          <summary>{t("review.history", { count: reviews.length })}</summary>
          <ol className="m-0 mt-8 flex list-none flex-col gap-4 p-0">
            {reviews.map((r) => (
              <li key={r.approvalRecordId} className="flex flex-wrap items-center gap-6">
                <Tag>{decisionLabel(r)}</Tag>
                <span>{r.approvalKey}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}
