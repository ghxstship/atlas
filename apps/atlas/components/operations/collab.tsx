"use client";

import type { Attachment } from "@xos/data/attachments";
import type { Thread } from "@xos/data/comments";
import { Button } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import {
  attachmentLinkAction,
  deleteCommentAction,
  postCommentAction,
  removeAttachmentAction,
  uploadAttachmentAction,
} from "@/lib/operations/collab-actions";
import { ActionForm, useErrorCopy } from "./action-form";

interface SubjectProps {
  readonly org: string;
  readonly subjectTable: string;
  readonly subjectId: string;
}

/** Comments on a record (Section 19.6): the main thread, oldest first, with a composer. */
export function CommentsPanel({
  org,
  subjectTable,
  subjectId,
  threads,
  names,
  me,
  canPost,
}: SubjectProps & {
  threads: readonly Thread[];
  names: Readonly<Record<string, string>>;
  me: string | null;
  canPost: boolean;
}) {
  const t = useTranslations("credentials.collab");
  const format = useFormatter();
  const hidden = { org, subjectTable, subjectId };
  const comments = threads.flatMap((th) => th.comments).filter((c) => !c.deletedAt);
  return (
    <section aria-labelledby="record-comments" className="flex flex-col gap-12">
      <h2 id="record-comments" className="m-0 text-text-14 font-semibold">
        {t("comments")}
      </h2>
      {comments.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("noComments")}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-12 p-0">
          {comments.map((c) => (
            <li key={c.id} className="flex flex-col gap-4 border-b border-border-subtle pb-12">
              <p className="m-0 flex flex-wrap items-baseline gap-8 text-text-12 text-text-secondary">
                <span className="font-medium text-text-primary">
                  {names[c.authorPersonId] ?? t("unknownAuthor")}
                </span>
                <time dateTime={c.createdAt}>
                  {format.dateTime(new Date(c.createdAt), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </time>
              </p>
              <p className="m-0 whitespace-pre-wrap text-text-13">{c.body}</p>
              {c.authorPersonId === me ? (
                <ActionForm
                  action={deleteCommentAction}
                  hidden={{ ...hidden, commentId: c.id }}
                  submitLabel={t("deleteComment")}
                  variant="ghost"
                  layout="inline"
                />
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {canPost ? (
        <ActionForm
          action={postCommentAction}
          hidden={hidden}
          submitLabel={t("post")}
          successKey="credentials.collab.posted"
          resetOnSuccess
        >
          <div className="flex w-full flex-col gap-4">
            <label
              htmlFor={`comment-${subjectId}`}
              className="text-text-12 font-medium text-text-secondary"
            >
              {t("newComment")}
            </label>
            <textarea
              id={`comment-${subjectId}`}
              name="body"
              rows={3}
              maxLength={10000}
              required
              className="rounded-control border border-border-control bg-bg-surface px-8 py-6 text-text-13 text-text-primary"
            />
          </div>
        </ActionForm>
      ) : null}
    </section>
  );
}

/** Attachments on a record: clean files download through a short-lived link; uploads are scanned. */
export function AttachmentsPanel({
  org,
  subjectTable,
  subjectId,
  attachments,
  canUpload,
}: SubjectProps & { attachments: readonly Attachment[]; canUpload: boolean }) {
  const t = useTranslations("credentials.collab");
  const errors = useErrorCopy();
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  const hidden = { org, subjectTable, subjectId };
  const open = (attachmentId: string) =>
    start(async () => {
      const url = await attachmentLinkAction({ org, subjectTable, subjectId, attachmentId });
      if (url) {
        setProblem(null);
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        setProblem(errors("fileNotReady"));
      }
    });
  return (
    <section aria-labelledby="record-attachments" className="flex flex-col gap-12">
      <h2 id="record-attachments" className="m-0 text-text-14 font-semibold">
        {t("attachments")}
      </h2>
      {problem ? (
        <p role="alert" className="m-0 text-text-13 text-danger-text">
          {problem}
        </p>
      ) : null}
      {attachments.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("noAttachments")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {attachments.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
              <span className="flex flex-col gap-2">
                <span className="text-text-13 font-medium">{a.title}</span>
                <span className="text-text-12 text-text-secondary">
                  {a.current ? t("ready") : t("scanning")}
                </span>
              </span>
              <span className="flex items-center gap-8">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!a.current || pending}
                  onClick={() => open(a.id)}
                >
                  {t("download")}
                </Button>
                {canUpload ? (
                  <ActionForm
                    action={removeAttachmentAction}
                    hidden={{ ...hidden, attachmentId: a.id }}
                    submitLabel={t("remove")}
                    variant="ghost"
                    layout="inline"
                  />
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canUpload ? (
        <ActionForm
          action={uploadAttachmentAction}
          hidden={hidden}
          submitLabel={t("upload")}
          successKey="credentials.collab.uploaded"
          layout="inline"
          resetOnSuccess
        >
          <div className="flex flex-col gap-4">
            <label
              htmlFor={`file-${subjectId}`}
              className="text-text-12 font-medium text-text-secondary"
            >
              {t("file")}
            </label>
            <input
              id={`file-${subjectId}`}
              name="file"
              type="file"
              required
              className="text-text-13"
            />
          </div>
        </ActionForm>
      ) : null}
    </section>
  );
}
