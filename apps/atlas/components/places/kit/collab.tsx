"use client";

import { ScanNotice } from "@/components/platform/scan-notice";
import type { Attachment } from "@xos/data/attachments";
import type { Thread } from "@xos/data/comments";
import { Button, InlineAlert, Tag, Textarea } from "@xos/ui";
import { useFormatter } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import {
  attachmentLinkAction,
  deleteCommentAction,
  postCommentAction,
  removeAttachmentAction,
  uploadAttachmentAction,
  type CollabResult,
  type CollabSubject,
} from "./collab-actions";
import { useCopy } from "./form";

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = <T,>(action: () => Promise<CollabResult<T>>, onDone?: (data: T) => void) => {
    setError(null);
    start(async () => {
      const result = await action();
      if (result.ok) {
        router.refresh();
        onDone?.(result.data);
      } else {
        setError(result.error);
      }
    });
  };
  return { pending, error, run };
}

function ErrorAlert({ error }: { error: string | null }) {
  const t = useCopy("places");
  if (!error) return null;
  return (
    <InlineAlert tone="danger" title={t("errors.title")}>
      {t(`errors.${error}`)}
    </InlineAlert>
  );
}

/**
 * Comments and attachments on one Places or Safety row (Section 19.6): the thread with a composer,
 * and files with versions and virus-scan state. Only Clean versions download.
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
  const t = useCopy("places");
  const format = useFormatter();
  const comments = useRun();
  const files = useRun();
  const [body, setBody] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const all = threads.flatMap((th) => th.comments);
  const scan = (a: Attachment) => a.versions[0]?.scanStatus ?? "Pending Upload";
  return (
    <div className="flex flex-col gap-24">
      <section aria-labelledby={`comments-${subject.id}`} className="flex flex-col gap-12">
        <h2 id={`comments-${subject.id}`} className="m-0 text-heading-16 font-semibold">
          {t("collab.comments")}
        </h2>
        <ErrorAlert error={comments.error} />
        {all.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {canPost ? t("collab.noComments") : t("collab.noCommentsReadOnly")}
          </p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-12 p-0">
            {all.map((c) => (
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
                  <p className="m-0 text-text-13 italic text-text-tertiary">
                    {t("collab.deleted")}
                  </p>
                ) : (
                  <p className="m-0 whitespace-pre-wrap text-text-14">{c.body}</p>
                )}
                {c.authorPersonId === me && !c.deletedAt ? (
                  <div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => comments.run(() => deleteCommentAction(org, c.id))}
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
              comments.run(
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
              width="100%"
            />
            <div>
              <Button type="submit" loading={comments.pending} disabled={body.trim() === ""}>
                {t("collab.post")}
              </Button>
            </div>
          </form>
        ) : null}
      </section>
      <section aria-labelledby={`attachments-${subject.id}`} className="flex flex-col gap-12">
        <h2 id={`attachments-${subject.id}`} className="m-0 text-heading-16 font-semibold">
          {t("collab.attachments")}
        </h2>
        <ErrorAlert error={files.error} />
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
                    {t("collab.version", {
                      n: a.versions[0]?.versionNumber ?? 1,
                      date: format.dateTime(new Date(a.createdAt), { dateStyle: "medium" }),
                    })}
                  </span>
                </span>
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
                    {t(`collab.scan.${scan(a)}`)}
                  </Tag>
                  {a.current ? (
                    <Button
                      size="sm"
                      onClick={() =>
                        files.run(
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
                      onClick={() => files.run(() => removeAttachmentAction(org, a.id))}
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
              files.run(
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
            <Button type="submit" loading={files.pending}>
              {t("collab.upload")}
            </Button>
          </form>
        ) : null}
      </section>
    </div>
  );
}
