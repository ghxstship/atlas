"use client";

import { ScanNotice } from "@/components/platform/scan-notice";
import type { Attachment } from "@xos/data/attachments";
import type { Thread } from "@xos/data/comments";
import { Button, Tag, Textarea } from "@xos/ui";
import { useFormatter } from "next-intl";
import { useRef, useState } from "react";
import { ActionErrorAlert, useAction, useCopy } from "./action-ui";
import {
  attachmentLinkAction,
  deleteCommentAction,
  postCommentAction,
  removeAttachmentAction,
  uploadAttachmentAction,
  type CollabSubject,
} from "./collab-actions";

/**
 * Comments and attachments on one Schedule, Work or Show row (Section 19.6, chat native in
 * Section 11.10 item 8): the main thread with a composer, and files with versions and scan status.
 */
export function CollabPanels({
  org,
  subject,
  threads,
  attachments,
  names,
  me,
  canPost,
}: {
  org: string;
  subject: CollabSubject;
  threads: readonly Thread[];
  attachments: readonly Attachment[];
  names: Readonly<Record<string, string>>;
  me: string | null;
  canPost: boolean;
}) {
  return (
    <div className="flex flex-col gap-24">
      <CommentsPanel
        org={org}
        subject={subject}
        threads={threads}
        names={names}
        me={me}
        canPost={canPost}
      />
      <AttachmentsPanel
        org={org}
        subject={subject}
        attachments={attachments}
        me={me}
        canPost={canPost}
      />
    </div>
  );
}

function CommentsPanel({
  org,
  subject,
  threads,
  names,
  me,
  canPost,
}: {
  org: string;
  subject: CollabSubject;
  threads: readonly Thread[];
  names: Readonly<Record<string, string>>;
  me: string | null;
  canPost: boolean;
}) {
  const t = useCopy("work");
  const format = useFormatter();
  const { pending, error, run } = useAction();
  const [body, setBody] = useState("");
  const comments = threads.flatMap((th) => th.comments);
  const headingId = `comments-${subject.id}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-12">
      <h2 id={headingId} className="m-0 text-heading-16 font-semibold">
        {t("collab.comments")}
      </h2>
      <ActionErrorAlert error={error} />
      {comments.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {canPost ? t("collab.noComments") : t("collab.noCommentsReadOnly")}
        </p>
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
                <p className="m-0 whitespace-pre-wrap text-text-14">{c.body}</p>
              )}
              {c.authorPersonId === me && !c.deletedAt ? (
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => run(() => deleteCommentAction(org, c.id))}
                  >
                    {t("collab.delete")}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {canPost ? (
        <form
          className="flex flex-col gap-8"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () => postCommentAction(org, subject, body),
              () => setBody(""),
            );
          }}
        >
          <Textarea
            id={`comment-${subject.id}`}
            label={t("collab.write")}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
          />
          <div>
            <Button type="submit" loading={pending} disabled={body.trim() === ""}>
              {t("collab.post")}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function AttachmentsPanel({
  org,
  subject,
  attachments,
  me,
  canPost,
}: {
  org: string;
  subject: CollabSubject;
  attachments: readonly Attachment[];
  me: string | null;
  canPost: boolean;
}) {
  const t = useCopy("work");
  const format = useFormatter();
  const { pending, error, run } = useAction();
  const fileRef = useRef<HTMLInputElement>(null);
  const headingId = `attachments-${subject.id}`;
  const scan = (a: Attachment) => a.versions[0]?.scanStatus ?? "Pending Upload";
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-12">
      <h2 id={headingId} className="m-0 text-heading-16 font-semibold">
        {t("collab.attachments")}
      </h2>
      <ActionErrorAlert error={error} />
      {attachments.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {canPost ? t("collab.noAttachments") : t("collab.noAttachmentsReadOnly")}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {attachments.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
              <span className="flex flex-col gap-2">
                <span className="text-text-14">{a.title}</span>
                <ScanNotice status={scan(a)} />
                <span className="text-text-12 text-text-secondary">
                  {t("collab.version", { n: a.versions[0]?.versionNumber ?? 1 })} ·{" "}
                  {format.dateTime(new Date(a.createdAt), { dateStyle: "medium" })}
                </span>
              </span>
              <span className="flex items-center gap-8">
                <Tag
                  tone={
                    scan(a) === "Clean" ? "success" : scan(a) === "Infected" ? "danger" : "neutral"
                  }
                >
                  {t(`collab.scan.${scan(a)}`)}
                </Tag>
                {a.current ? (
                  <Button
                    size="sm"
                    onClick={() =>
                      run(
                        () => attachmentLinkAction(org, subject, a.id),
                        (url) => window.open(url, "_blank", "noopener"),
                      )
                    }
                  >
                    {t("collab.download")}
                  </Button>
                ) : null}
                {a.createdBy === me ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => run(() => removeAttachmentAction(org, a.id))}
                  >
                    {t("collab.remove")}
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canPost ? (
        <form
          className="flex flex-wrap items-end gap-8"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            form.set("org", org);
            form.set("table", subject.table);
            form.set("id", subject.id);
            run(
              () => uploadAttachmentAction(form),
              () => {
                if (fileRef.current) fileRef.current.value = "";
              },
            );
          }}
        >
          <label className="flex flex-col gap-4 text-text-13">
            <span className="font-medium">{t("collab.file")}</span>
            <input ref={fileRef} name="file" type="file" required className="text-text-13" />
          </label>
          <Button type="submit" loading={pending}>
            {t("collab.upload")}
          </Button>
        </form>
      ) : null}
    </section>
  );
}
