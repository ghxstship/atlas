"use client";

import type { Attachment, FileReviewDecision, VersionReview } from "@xos/data/attachments";
import { Button, Tag, Textarea } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { ActionErrorAlert, useAction } from "@/components/work/action-ui";
import { reviewFileVersionAction } from "@/components/work/review-actions";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * File review on a submittal or a record (B14, G-268; ADR 0153 D6): each file's versions, newest first, each with its
 * decision as a text tag; Approve and Request changes (with a note) on the current version, the newest Clean one; and
 * every version's review history. Reviews are append-only and a new version starts unreviewed. The uploader of a
 * version never reviews it (sod_file_review_uploader); the database decides. Loaded on demand through
 * components/lazy-ui/file-review.tsx, from collection-kit CollabPanels (submittals) and the record page (records).
 */
export function FileReviewControls({
  org,
  attachments,
  reviews,
  me,
  canReview,
}: {
  org: string;
  attachments: readonly Attachment[];
  /** Every review of these files' versions, newest first. */
  reviews: readonly VersionReview[];
  me: string | null;
  canReview: boolean;
}) {
  const t = useTranslations("procurement.fileReview") as unknown as Translate;
  const format = useFormatter();
  if (attachments.length === 0) return null;
  const latestOf = (versionId: string) =>
    reviews.find((r) => r.attachmentVersionId === versionId) ?? null;
  const label = (decision: FileReviewDecision | null) =>
    decision === "Approved"
      ? t("approved")
      : decision === "Changes Requested"
        ? t("changesRequested")
        : t("unreviewed");

  return (
    <section aria-labelledby="file-reviews" className="flex flex-col gap-12">
      <h2 id="file-reviews" className="m-0 text-heading-16 font-semibold">
        {t("title")}
      </h2>
      <ul className="m-0 flex list-none flex-col gap-16 p-0">
        {attachments.map((a) => (
          <li key={a.id} className="flex flex-col gap-8 border-b border-border-subtle pb-12">
            <span className="text-text-14 font-medium">{a.title}</span>
            <ol
              className="m-0 flex list-none flex-col gap-8 p-0"
              aria-label={t("versions", { title: a.title })}
            >
              {a.versions.map((v) => {
                const latest = latestOf(v.id);
                const current = a.current?.id === v.id;
                const history = reviews.filter((r) => r.attachmentVersionId === v.id);
                return (
                  <li key={v.id} className="flex flex-col gap-4 text-text-13">
                    <span className="flex flex-wrap items-center gap-6">
                      <span className="font-mono text-text-12">
                        {t("version", { n: v.versionNumber })}
                      </span>
                      <span>{v.filename}</span>
                      {v.scanStatus === "Clean" ? (
                        <Tag
                          tone={
                            latest?.decision === "Approved"
                              ? "success"
                              : latest?.decision === "Changes Requested"
                                ? "warning"
                                : "neutral"
                          }
                        >
                          {label(latest?.decision ?? null)}
                        </Tag>
                      ) : (
                        <Tag>{t("notClean")}</Tag>
                      )}
                      {current ? <Tag tone="accent">{t("current")}</Tag> : null}
                    </span>
                    {latest?.note ? (
                      <span className="text-text-secondary">{latest.note}</span>
                    ) : null}
                    {current && canReview && v.scanStatus === "Clean" ? (
                      <ReviewForm
                        org={org}
                        versionId={v.id}
                        mine={v.uploadedBy !== null && v.uploadedBy === me}
                      />
                    ) : null}
                    {history.length > 0 ? (
                      <details>
                        <summary className="text-text-12">
                          {t("history", { count: history.length })}
                        </summary>
                        <ol className="m-0 mt-4 flex list-none flex-col gap-2 p-0 text-text-12 text-text-secondary">
                          {history.map((r) => (
                            <li key={r.id}>
                              {t(r.note ? "historyLineNote" : "historyLine", {
                                decision: label(r.decision),
                                reviewer: r.reviewerName ?? t("someone"),
                                at: format.dateTime(new Date(r.reviewedAt), {
                                  dateStyle: "medium",
                                  timeStyle: "short",
                                }),
                                note: r.note ?? "",
                              })}
                            </li>
                          ))}
                        </ol>
                      </details>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReviewForm({ org, versionId, mine }: { org: string; versionId: string; mine: boolean }) {
  const t = useTranslations("procurement.fileReview") as unknown as Translate;
  const [note, setNote] = useState("");
  const { pending, error, run } = useAction();
  if (mine) return <p className="m-0 text-text-12 text-text-secondary">{t("yourUpload")}</p>;
  const decide = (decision: FileReviewDecision) =>
    run(
      () => reviewFileVersionAction(org, { versionId, decision, note: note.trim() || null }),
      () => setNote(""),
    );
  return (
    <div className="flex flex-col gap-6">
      <Textarea
        id={`file-review-note-${versionId}`}
        label={t("note")}
        help={t("noteHelp")}
        maxLength={1000}
        width="100%"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="flex flex-wrap gap-8">
        <Button
          type="button"
          size="sm"
          variant="primary"
          loading={pending}
          onClick={() => decide("Approved")}
        >
          {t("approve")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          loading={pending}
          onClick={() => decide("Changes Requested")}
        >
          {t("requestChanges")}
        </Button>
      </div>
      <ActionErrorAlert error={error} />
    </div>
  );
}
