"use client";

import { Avatar, Button, InlineAlert, Textarea } from "@xos/ui";
import { useFormatter } from "next-intl";
import { useCopy } from "./use-copy";
import { useActionState, useEffect, useRef, type ReactNode } from "react";
import {
  attachmentLinkAction,
  deleteCommentAction,
  postCommentAction,
  removeAttachmentAction,
  uploadAttachmentAction,
  type CollabState,
} from "@/lib/collection-kit/collab-actions";
import { KitSection } from "./kit";

/**
 * The comment thread and attachments of one A16 row (A18's unified services). Comments post with
 * Enter-free forms so screen reader users keep control; attachments upload, download through a
 * short-lived link once scanned clean, and can be removed by their uploader.
 */

export interface CollabComment {
  readonly id: string;
  readonly author: string;
  readonly mine: boolean;
  readonly body: string;
  readonly createdAt: string;
  readonly deleted: boolean;
}

export interface CollabAttachment {
  readonly id: string;
  readonly title: string;
  readonly filename: string | null;
  readonly sizeBytes: number | null;
  readonly ready: boolean;
  readonly mine: boolean;
}

const INITIAL: CollabState = {};

function Hidden({ org, table, id }: { org: string; table: string; id: string }) {
  return (
    <>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="table" value={table} />
      <input type="hidden" name="id" value={id} />
    </>
  );
}

function Problem({ state }: { state: CollabState }) {
  const t = useCopy("procurement.kit");
  if (state.rule) return <InlineAlert tone="warning">{t("refusalFamily.other")}</InlineAlert>;
  if (state.error) return <InlineAlert tone="danger">{t(`errors.${state.error}`)}</InlineAlert>;
  return null;
}

function SmallAction({
  action,
  fields,
  label,
  onLink,
}: {
  action: (state: CollabState, form: FormData) => Promise<CollabState>;
  fields: ReactNode;
  label: string;
  onLink?: (link: string) => void;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL);
  const seen = useRef<CollabState | null>(null);
  useEffect(() => {
    if (state.link && seen.current !== state) {
      seen.current = state;
      onLink?.(state.link);
    }
  }, [state, onLink]);
  return (
    <form action={formAction} className="inline-flex flex-col gap-4">
      {fields}
      <Button type="submit" size="sm" variant="ghost" loading={pending}>
        {label}
      </Button>
      <Problem state={state} />
    </form>
  );
}

export function CollabClient({
  org,
  table,
  id,
  comments,
  attachments,
}: {
  org: string;
  table: string;
  id: string;
  comments: readonly CollabComment[];
  attachments: readonly CollabAttachment[];
}) {
  const t = useCopy("procurement.kit.collab");
  const format = useFormatter();
  const [posted, post, posting] = useActionState(postCommentAction, INITIAL);
  const [uploaded, upload, uploading] = useActionState(uploadAttachmentAction, INITIAL);
  const commentForm = useRef<HTMLFormElement>(null);
  const uploadForm = useRef<HTMLFormElement>(null);
  const lastPost = useRef<CollabState | null>(null);
  const lastUpload = useRef<CollabState | null>(null);
  useEffect(() => {
    if (posted.ok && lastPost.current !== posted) {
      lastPost.current = posted;
      commentForm.current?.reset();
    }
  }, [posted]);
  useEffect(() => {
    if (uploaded.ok && lastUpload.current !== uploaded) {
      lastUpload.current = uploaded;
      uploadForm.current?.reset();
    }
  }, [uploaded]);
  const prefix = `collab-${id}`;

  return (
    <>
      <KitSection id={`${prefix}-comments`} title={t("comments")}>
        {comments.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("noComments")}</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-12 p-0">
            {comments.map((c) => (
              <li key={c.id} className="flex gap-8">
                <Avatar name={c.author} />
                <div className="flex min-w-0 flex-col gap-2">
                  <span className="text-text-12 text-text-secondary">
                    {c.author} ·{" "}
                    {format.dateTime(new Date(c.createdAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </span>
                  <p className="m-0 whitespace-pre-wrap text-text-13">
                    {c.deleted ? t("deleted") : c.body}
                  </p>
                  {c.mine && !c.deleted ? (
                    <SmallAction
                      action={deleteCommentAction}
                      label={t("delete")}
                      fields={
                        <>
                          <input type="hidden" name="org" value={org} />
                          <input type="hidden" name="commentId" value={c.id} />
                        </>
                      }
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
        <form ref={commentForm} action={post} className="flex flex-col gap-8" noValidate>
          <Hidden org={org} table={table} id={id} />
          <Textarea
            id={`${prefix}-body`}
            name="body"
            label={t("add")}
            rows={3}
            width="100%"
            error={posted.fieldErrors?.["body"] ? t("bodyRequired") : ""}
          />
          <Problem state={posted} />
          <div>
            <Button type="submit" size="sm" loading={posting}>
              {t("post")}
            </Button>
          </div>
        </form>
      </KitSection>
      <KitSection id={`${prefix}-files`} title={t("attachments")}>
        {attachments.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("noAttachments")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {attachments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-text-13">{a.title}</span>
                  <span className="text-text-12 text-text-secondary">
                    {a.ready
                      ? t("size", { kb: Math.max(1, Math.round((a.sizeBytes ?? 0) / 1024)) })
                      : t("scanning")}
                  </span>
                </span>
                <span className="flex items-center gap-4">
                  {a.ready ? (
                    <SmallAction
                      action={attachmentLinkAction}
                      label={t("download")}
                      fields={
                        <>
                          <Hidden org={org} table={table} id={id} />
                          <input type="hidden" name="attachmentId" value={a.id} />
                        </>
                      }
                      onLink={(link) => window.open(link, "_blank", "noopener")}
                    />
                  ) : null}
                  {a.mine ? (
                    <SmallAction
                      action={removeAttachmentAction}
                      label={t("remove")}
                      fields={
                        <>
                          <input type="hidden" name="org" value={org} />
                          <input type="hidden" name="attachmentId" value={a.id} />
                        </>
                      }
                    />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        <form ref={uploadForm} action={upload} className="flex flex-col gap-8" noValidate>
          <Hidden org={org} table={table} id={id} />
          <label htmlFor={`${prefix}-file`} className="text-label-13 font-medium">
            {t("file")}
          </label>
          <input id={`${prefix}-file`} type="file" name="file" />
          {uploaded.fieldErrors?.["file"] ? (
            <p role="alert" className="m-0 text-text-12 text-danger-text">
              {t(uploaded.fieldErrors["file"] === "fileSize" ? "fileTooLarge" : "fileRequired")}
            </p>
          ) : null}
          <Problem state={uploaded} />
          <div>
            <Button type="submit" size="sm" loading={uploading}>
              {t("upload")}
            </Button>
          </div>
        </form>
      </KitSection>
    </>
  );
}
