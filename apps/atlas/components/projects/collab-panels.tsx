"use client";

import { ScanNotice } from "@/components/platform/scan-notice";
import type { Attachment } from "@xos/data/attachments";
import type { Thread } from "@xos/data/comments";
import { Button, Input, Tag, Textarea } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useState } from "react";
import {
  attachmentLinkAction,
  deleteCommentAction,
  postCommentAction,
  removeAttachmentAction,
  uploadAttachmentAction,
} from "@/lib/projects/collab-actions";
import { ActionError, echoed, fieldError } from "./action-error";

import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { AttachmentPreview } from "@/components/files/file-preview";
/** Comments on a project (Section 19.6): the main thread, newest last, with a composer. */
export function CommentsPanel({
  org,
  projectKey,
  threads,
  names,
  me,
  canPost,
}: {
  org: string;
  projectKey: string;
  threads: readonly Thread[];
  names: Readonly<Record<string, string>>;
  me: string | null;
  canPost: boolean;
}) {
  const t = useTranslations("projects");
  const format = useFormatter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(postCommentAction, {});
  const [removed, remove] = useActionState(deleteCommentAction, {});
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);
  const comments = threads.flatMap((th) => th.comments);
  return (
    <section aria-labelledby="project-comments" className="flex flex-col gap-12">
      <h2 id="project-comments" className="m-0 text-heading-16 font-semibold">
        {t("collab.commentsTitle")}
      </h2>
      <ActionError state={removed} />
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
                {c.editedAt ? <span>{t("collab.edited")}</span> : null}
              </p>
              {c.deletedAt ? (
                <p className="m-0 text-text-13 italic text-text-tertiary">{t("collab.deleted")}</p>
              ) : (
                <p className="m-0 whitespace-pre-wrap text-text-14 text-text-primary">{c.body}</p>
              )}
              {c.authorPersonId === me && !c.deletedAt ? (
                <form action={remove} onSubmit={keepInputOnSubmit(remove)}>
                  <input type="hidden" name="org" value={org} />
                  <input type="hidden" name="projectKey" value={projectKey} />
                  <input type="hidden" name="commentId" value={c.id} />
                  <Button type="submit" size="sm" variant="ghost">
                    {t("collab.delete")}
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {canPost ? (
        <form
          ref={formRef}
          action={action}
          onSubmit={keepInputOnSubmit(action)}
          className="flex flex-col gap-8"
          noValidate
        >
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="projectKey" value={projectKey} />
          <ActionError state={state} />
          <Textarea
            id="project-comment"
            name="body"
            required
            maxLength={10_000}
            width="100%"
            defaultValue={echoed(state, "body")}
            label={t("collab.addComment")}
            error={fieldError(t, state, "body")}
          />
          <div>
            <Button type="submit" variant="secondary" size="sm" loading={pending}>
              {t("collab.post")}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

/** Files attached to a project, with upload, download of clean versions and removal. */
export function AttachmentsPanel({
  org,
  projectKey,
  attachments,
  canUpload,
}: {
  org: string;
  projectKey: string;
  attachments: readonly Attachment[];
  canUpload: boolean;
}) {
  const t = useTranslations("projects");
  const format = useFormatter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(uploadAttachmentAction, {});
  const [removed, remove] = useActionState(removeAttachmentAction, {});
  const [linkError, setLinkError] = useState(false);
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);
  const open = async (id: string) => {
    const url = await attachmentLinkAction(org, projectKey, id);
    setLinkError(url === null);
    if (url) window.open(url, "_blank", "noopener");
  };
  return (
    <section aria-labelledby="project-attachments" className="flex flex-col gap-12">
      <h2 id="project-attachments" className="m-0 text-heading-16 font-semibold">
        {t("collab.attachmentsTitle")}
      </h2>
      <ActionError state={removed} />
      {linkError ? <ActionError state={{ error: "not-found" }} /> : null}
      {attachments.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {canUpload ? t("collab.noAttachments") : t("collab.noAttachmentsReadOnly")}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {attachments.map((a) => {
            const latest = a.versions[0];
            const status = latest?.scanStatus;
            return (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-text-14 text-text-primary">{a.title}</span>
                  <ScanNotice status={status} />
                  <span className="text-text-12 text-text-secondary">
                    {latest
                      ? `${format.number(latest.sizeBytes / 1024, { maximumFractionDigits: 0 })} KB`
                      : null}
                  </span>
                </span>
                <span className="flex items-center gap-6">
                  {status === "Clean" ? null : (
                    <Tag tone={status === "Infected" ? "danger" : "warning"}>
                      {status === "Infected" ? t("collab.infected") : t("collab.scanning")}
                    </Tag>
                  )}
                  <AttachmentPreview attachment={a} />
                  {a.current ? (
                    <Button size="sm" variant="secondary" onClick={() => void open(a.id)}>
                      {t("collab.download")}
                    </Button>
                  ) : null}
                  {canUpload ? (
                    <form action={remove} onSubmit={keepInputOnSubmit(remove)}>
                      <input type="hidden" name="org" value={org} />
                      <input type="hidden" name="projectKey" value={projectKey} />
                      <input type="hidden" name="attachmentId" value={a.id} />
                      <Button type="submit" size="sm" variant="ghost">
                        {t("collab.remove")}
                      </Button>
                    </form>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {canUpload ? (
        <form
          ref={formRef}
          action={action}
          onSubmit={keepInputOnSubmit(action)}
          className="flex flex-wrap items-end gap-8"
          noValidate
        >
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="projectKey" value={projectKey} />
          <ActionError state={state} />
          <Input
            id="project-file"
            name="file"
            type="file"
            label={t("collab.addFile")}
            error={fieldError(t, state, "file")}
          />
          <Button type="submit" size="sm" variant="secondary" loading={pending}>
            {t("collab.upload")}
          </Button>
        </form>
      ) : null}
    </section>
  );
}
