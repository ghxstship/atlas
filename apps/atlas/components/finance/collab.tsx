"use client";

import type { Attachment } from "@xos/data/attachments";
import type { Thread } from "@xos/data/comments";
import { Button } from "@xos/ui";
import { useFormatter } from "next-intl";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import {
  attachmentLinkAction,
  deleteCommentAction,
  postCommentAction,
  removeAttachmentAction,
  uploadAttachmentAction,
} from "@/lib/finance/collab-actions";
import { ActionFeedback, InlineActionButton, fieldError, useFinanceT } from "./kit";

import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
/**
 * Comments and attachments on a finance document (Section 19.6), on A18's unified comment system and
 * attachment service. Anyone who can read the document may comment; uploads are offered to people who
 * may change it. Files download only once their virus scan is clean.
 */

interface Subject {
  readonly org: string;
  readonly subjectTable: string;
  readonly subjectId: string;
}

export function FinanceComments({
  org,
  subjectTable,
  subjectId,
  threads,
  names,
  me,
}: Subject & {
  threads: readonly Thread[];
  names: Readonly<Record<string, string>>;
  me: string | null;
}) {
  const t = useFinanceT();
  const format = useFormatter();
  const [state, action, pending] = useActionState(postCommentAction, {});
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) form.current?.reset();
  }, [state.at, state.ok]);
  const comments = threads.flatMap((th) => th.comments).filter((c) => !c.deletedAt);
  const hidden = { org, subjectTable, subjectId };
  return (
    <section aria-labelledby={`comments-${subjectId}`} className="flex flex-col gap-12">
      <h3 id={`comments-${subjectId}`} className="m-0 text-text-14 font-semibold">
        {t("collab.comments")}
      </h3>
      {comments.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("collab.noComments")}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-12 p-0">
          {comments.map((c) => (
            <li key={c.id} className="flex flex-col gap-4 border-b border-border-subtle pb-12">
              <p className="m-0 flex flex-wrap items-baseline gap-8 text-text-12 text-text-secondary">
                <span className="font-medium text-text-primary">
                  {names[c.authorPersonId] ?? t("collab.unknownAuthor")}
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
                <div>
                  <InlineActionButton
                    action={deleteCommentAction}
                    fields={{ ...hidden, commentId: c.id }}
                    label={t("collab.deleteComment")}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <form
        ref={form}
        action={action}
        onSubmit={keepInputOnSubmit(action)}
        className="flex flex-col gap-8"
      >
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="subjectTable" value={subjectTable} />
        <input type="hidden" name="subjectId" value={subjectId} />
        <label
          htmlFor={`comment-${subjectId}`}
          className="text-text-12 font-medium text-text-secondary"
        >
          {t("collab.newComment")}
        </label>
        <textarea
          id={`comment-${subjectId}`}
          name="body"
          rows={3}
          maxLength={10000}
          required
          aria-invalid={state.fieldErrors?.["body"] ? true : undefined}
          className="rounded-control border border-border-control bg-bg-surface px-8 py-6 text-text-13 text-text-primary"
        />
        {state.fieldErrors?.["body"] ? (
          <p role="alert" className="m-0 text-text-12 text-danger-text">
            {fieldError(t, state, "body")}
          </p>
        ) : null}
        <ActionFeedback state={state} success={t("collab.posted")} />
        <div>
          <Button type="submit" loading={pending}>
            {t("collab.post")}
          </Button>
        </div>
      </form>
    </section>
  );
}

export function FinanceAttachments({
  org,
  subjectTable,
  subjectId,
  attachments,
  canUpload,
}: Subject & { attachments: readonly Attachment[]; canUpload: boolean }) {
  const t = useFinanceT();
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState(false);
  const [state, action, uploading] = useActionState(uploadAttachmentAction, {});
  const hidden = { org, subjectTable, subjectId };
  const open = (attachmentId: string) =>
    start(async () => {
      const url = await attachmentLinkAction({ ...hidden, attachmentId });
      setProblem(!url);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    });
  return (
    <section aria-labelledby={`attachments-${subjectId}`} className="flex flex-col gap-12">
      <h3 id={`attachments-${subjectId}`} className="m-0 text-text-14 font-semibold">
        {t("collab.attachments")}
      </h3>
      {problem ? (
        <p role="alert" className="m-0 text-text-13 text-danger-text">
          {t("collab.fileNotReady")}
        </p>
      ) : null}
      {attachments.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {canUpload ? t("collab.noAttachments") : t("collab.noAttachmentsRead")}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {attachments.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
              <span className="flex flex-col gap-2">
                <span className="text-text-13 font-medium">{a.title}</span>
                <span className="text-text-12 text-text-secondary">
                  {a.current ? t("collab.ready") : t("collab.scanning")}
                </span>
              </span>
              <span className="flex items-center gap-8">
                <Button size="sm" disabled={!a.current || pending} onClick={() => open(a.id)}>
                  {t("collab.download")}
                </Button>
                {canUpload ? (
                  <InlineActionButton
                    action={removeAttachmentAction}
                    fields={{ ...hidden, attachmentId: a.id }}
                    label={t("collab.remove")}
                  />
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canUpload ? (
        <form
          action={action}
          onSubmit={keepInputOnSubmit(action)}
          className="flex flex-wrap items-end gap-8"
        >
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="subjectTable" value={subjectTable} />
          <input type="hidden" name="subjectId" value={subjectId} />
          <span className="flex flex-col gap-4">
            <label
              htmlFor={`file-${subjectId}`}
              className="text-text-12 font-medium text-text-secondary"
            >
              {t("collab.file")}
            </label>
            <input
              id={`file-${subjectId}`}
              name="file"
              type="file"
              required
              className="text-text-13"
            />
          </span>
          <Button type="submit" loading={uploading}>
            {t("collab.upload")}
          </Button>
          {state.fieldErrors?.["file"] ? (
            <p role="alert" className="m-0 w-full text-text-12 text-danger-text">
              {fieldError(t, state, "file")}
            </p>
          ) : (
            <ActionFeedback state={state} success={t("collab.uploaded")} />
          )}
        </form>
      ) : null}
    </section>
  );
}
