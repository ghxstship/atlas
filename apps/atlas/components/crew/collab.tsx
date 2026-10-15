"use client";

import type { Attachment } from "@xos/data/attachments";
import type { Thread } from "@xos/data/comments";
import { Button, InlineAlert, Tag, Textarea } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useRef } from "react";
import {
  attachmentLinkAction,
  deleteCommentAction,
  postCommentAction,
  removeAttachmentAction,
  uploadAttachmentAction,
} from "@/app/[org]/crew/collab-actions";
import type { CrewActionState } from "@/lib/crew/action-state";

type Action = (state: CrewActionState, form: FormData) => Promise<CrewActionState>;

/** Runs an action, refreshes the page on success and keeps the latest error to show. */
function useCollab(action: Action, after?: (state: CrewActionState) => void) {
  const router = useRouter();
  return useActionState(async (prev: CrewActionState, form: FormData) => {
    const next = await action(prev, form);
    if (next.ok) {
      after?.(next);
      router.refresh();
    }
    return next;
  }, {});
}

function Error({ state }: { state: CrewActionState }) {
  const t = useTranslations("crew.form");
  return state.error ? (
    <InlineAlert tone="danger" title={t("refused")}>
      {state.error}
    </InlineAlert>
  ) : null;
}

/**
 * The comment thread and attachments of a People or Crew record (Section 11.2, rule 4), on A18's
 * unified comment system and attachment service. Uploads are virus scanned; only clean files download.
 */
export function CrewCollab(props: {
  org: string;
  table: string;
  id: string;
  threads: readonly Thread[];
  attachments: readonly Attachment[];
  names: Readonly<Record<string, string>>;
  me: string | null;
}) {
  const t = useTranslations("crew.collab");
  const format = useFormatter();
  const composer = useRef<HTMLFormElement>(null);
  const files = useRef<HTMLFormElement>(null);
  const [posted, post, posting] = useCollab(postCommentAction, () => composer.current?.reset());
  const [removed, remove] = useCollab(deleteCommentAction);
  const [uploaded, upload, uploading] = useCollab(uploadAttachmentAction, () =>
    files.current?.reset(),
  );
  const [dropped, drop] = useCollab(removeAttachmentAction);
  const [linked, link] = useActionState(async (prev: CrewActionState, form: FormData) => {
    const next = await attachmentLinkAction(prev, form);
    if (next.ok && next.redirect) window.open(next.redirect, "_blank", "noopener");
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
      <section aria-labelledby={`comments-${props.id}`} className="flex flex-col gap-8">
        <h2 id={`comments-${props.id}`} className="m-0 text-text-13 font-semibold">
          {t("comments")}
        </h2>
        <Error state={removed} />
        {comments.length === 0 ? (
          <p className="m-0 text-text-12 text-text-secondary">{t("noComments")}</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-8 p-0">
            {comments.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 border-b border-border-subtle pb-8">
                <p className="m-0 flex flex-wrap items-baseline gap-8 text-text-12 text-text-secondary">
                  <span className="font-medium text-text-primary">
                    {props.names[c.authorPersonId] ?? t("unknownAuthor")}
                  </span>
                  <time dateTime={c.createdAt}>
                    {format.dateTime(new Date(c.createdAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </time>
                </p>
                {c.deletedAt ? (
                  <p className="m-0 text-text-12 text-text-tertiary">{t("deleted")}</p>
                ) : (
                  <p className="m-0 whitespace-pre-wrap text-text-13">{c.body}</p>
                )}
                {c.authorPersonId === props.me && !c.deletedAt ? (
                  <form action={remove}>
                    <input type="hidden" name="org" value={props.org} />
                    <input type="hidden" name="commentId" value={c.id} />
                    <Button type="submit" size="sm" variant="ghost">
                      {t("delete")}
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        <form ref={composer} action={post} className="flex flex-col gap-8">
          {subject}
          <Error state={posted} />
          <Textarea
            id={`comment-${props.id}`}
            name="body"
            label={t("write")}
            rows={3}
            width="100%"
          />
          <div>
            <Button type="submit" size="sm" loading={posting}>
              {t("post")}
            </Button>
          </div>
        </form>
      </section>
      <section aria-labelledby={`files-${props.id}`} className="flex flex-col gap-8">
        <h2 id={`files-${props.id}`} className="m-0 text-text-13 font-semibold">
          {t("attachments")}
        </h2>
        <Error state={dropped} />
        <Error state={linked} />
        {props.attachments.length === 0 ? (
          <p className="m-0 text-text-12 text-text-secondary">{t("noAttachments")}</p>
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
                    {t(`scan.${scan(a)}`)}
                  </Tag>
                  {a.current ? (
                    <form action={link}>
                      {subject}
                      <input type="hidden" name="attachmentId" value={a.id} />
                      <Button type="submit" size="sm">
                        {t("download")}
                      </Button>
                    </form>
                  ) : null}
                  {a.createdBy === props.me ? (
                    <form action={drop}>
                      <input type="hidden" name="org" value={props.org} />
                      <input type="hidden" name="attachmentId" value={a.id} />
                      <Button type="submit" size="sm" variant="ghost">
                        {t("remove")}
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
          <Error state={uploaded} />
          <label className="flex flex-col gap-4 text-text-12">
            <span className="font-medium">{t("file")}</span>
            <input name="file" type="file" required className="text-text-12" />
          </label>
          <Button type="submit" size="sm" loading={uploading}>
            {t("upload")}
          </Button>
        </form>
      </section>
    </div>
  );
}
