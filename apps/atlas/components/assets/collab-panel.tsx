"use client";

import type { Attachment } from "@xos/data/attachments";
import type { Thread } from "@xos/data/comments";
import { Button, Tag, Textarea } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useFormatter } from "next-intl";
import { useActionState, useRef } from "react";
import {
  attachmentLinkAction,
  deleteCommentAction,
  postCommentAction,
  removeAttachmentAction,
  uploadAttachmentAction,
  type CollabState,
} from "@/app/[org]/assets/collab-actions";
import { useAssetsCopy } from "./copy";
import { ActionError } from "./dialog";

type Action = (state: CollabState, form: FormData) => Promise<CollabState>;

function useCollab(action: Action, after?: (state: CollabState) => void) {
  const router = useRouter();
  return useActionState(async (prev: CollabState, form: FormData) => {
    const next = await action(prev, form);
    if (next.ok) {
      after?.(next);
      router.refresh();
    }
    return next;
  }, {});
}

/**
 * The comment thread and attachments of an asset row (Section 19.6) on A18's unified comment system
 * and attachment service. Uploads are virus scanned; only clean files download.
 */
export function AssetCollabPanel(props: {
  org: string;
  table: string;
  id: string;
  threads: readonly Thread[];
  attachments: readonly Attachment[];
  names: Readonly<Record<string, string>>;
  me: string | null;
}) {
  const t = useAssetsCopy();
  const format = useFormatter();
  const composer = useRef<HTMLFormElement>(null);
  const files = useRef<HTMLFormElement>(null);
  const [posted, post, posting] = useCollab(postCommentAction, () => composer.current?.reset());
  const [removed, remove] = useCollab(deleteCommentAction);
  const [uploaded, upload, uploading] = useCollab(uploadAttachmentAction, () =>
    files.current?.reset(),
  );
  const [dropped, drop] = useCollab(removeAttachmentAction);
  const [linked, link] = useActionState(async (prev: CollabState, form: FormData) => {
    const next = await attachmentLinkAction(prev, form);
    if (next.ok && next.link) window.open(next.link, "_blank", "noopener");
    return next;
  }, {});
  const comments = props.threads.flatMap((th) => th.comments);
  const subject = (
    <>
      <input type="hidden" name="org" value={props.org} />
      <input type="hidden" name="table" value={props.table} />
      <input type="hidden" name="id" value={props.id} />
    </>
  );
  const scan = (a: Attachment) => a.versions[0]?.scanStatus ?? "Pending Upload";
  return (
    <div className="flex flex-col gap-16">
      <section aria-labelledby={`asset-comments-${props.id}`} className="flex flex-col gap-8">
        <h3 id={`asset-comments-${props.id}`} className="m-0 text-heading-14 font-semibold">
          {t("collab.comments")}
        </h3>
        <ActionError state={removed} />
        {comments.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("collab.noComments")}</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-8 p-0">
            {comments.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 border-b border-border-subtle pb-8">
                <p className="m-0 flex flex-wrap items-baseline gap-8 text-text-12 text-text-secondary">
                  <span className="font-medium text-text-primary">
                    {props.names[c.authorPersonId] ?? t("collab.unknownAuthor")}
                  </span>
                  <time dateTime={c.createdAt}>
                    {format.dateTime(new Date(c.createdAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </time>
                </p>
                {c.deletedAt ? (
                  <p className="m-0 text-text-12 text-text-secondary">{t("collab.deleted")}</p>
                ) : (
                  <p className="m-0 whitespace-pre-wrap text-text-13">{c.body}</p>
                )}
                {c.authorPersonId === props.me && !c.deletedAt ? (
                  <form action={remove}>
                    <input type="hidden" name="org" value={props.org} />
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
        <form ref={composer} action={post} className="flex flex-col gap-8">
          {subject}
          <ActionError state={posted} />
          <Textarea
            id={`asset-comment-${props.id}`}
            name="body"
            label={t("collab.write")}
            rows={3}
            width="100%"
          />
          <div>
            <Button type="submit" size="sm" loading={posting}>
              {t("collab.post")}
            </Button>
          </div>
        </form>
      </section>
      <section aria-labelledby={`asset-files-${props.id}`} className="flex flex-col gap-8">
        <h3 id={`asset-files-${props.id}`} className="m-0 text-heading-14 font-semibold">
          {t("collab.attachments")}
        </h3>
        <ActionError state={dropped} />
        <ActionError state={linked} />
        {props.attachments.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("collab.noAttachments")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {props.attachments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-8 py-6">
                <span className="text-text-13">{a.title}</span>
                <span className="flex items-center gap-8">
                  <Tag
                    tone={
                      scan(a) === "Clean"
                        ? "success"
                        : scan(a) === "Infected"
                          ? "danger"
                          : "neutral"
                    }
                  >
                    {t(`collab.scan.${scan(a).replace(/\s/g, "")}`)}
                  </Tag>
                  {a.current ? (
                    <form action={link}>
                      {subject}
                      <input type="hidden" name="attachmentId" value={a.id} />
                      <Button type="submit" size="sm">
                        {t("collab.download")}
                      </Button>
                    </form>
                  ) : null}
                  {a.createdBy === props.me ? (
                    <form action={drop}>
                      <input type="hidden" name="org" value={props.org} />
                      <input type="hidden" name="attachmentId" value={a.id} />
                      <Button type="submit" size="sm" variant="ghost">
                        {t("collab.remove")}
                      </Button>
                    </form>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        <form ref={files} action={upload} className="flex flex-wrap items-end gap-8">
          {subject}
          <ActionError state={uploaded} />
          <label className="flex flex-col gap-4 text-text-12">
            <span className="font-medium">{t("collab.file")}</span>
            <input name="file" type="file" required className="text-text-12" />
          </label>
          <Button type="submit" size="sm" loading={uploading}>
            {t("collab.upload")}
          </Button>
        </form>
      </section>
    </div>
  );
}
