"use client";

import type { Attachment } from "@xos/data/attachments";
import type { Thread } from "@xos/data/comments";
import { Button, Tag, Textarea } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import type { ActionState } from "@/lib/logistics-hospitality/actions-kit";
import {
  attachmentLinkAction,
  deleteCommentAction,
  postCommentAction,
  removeAttachmentAction,
  uploadAttachmentAction,
  type CollabSubject,
} from "./collab-actions";
import { ActionAlert } from "./forms";

type Translate = (key: string, values?: Record<string, string | number>) => string;

function useCollabCopy(): Translate {
  const t = useTranslations("logistics.common.collab");
  return (key, values) => (t as unknown as Translate)(key, values);
}

function useRun() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<ActionState>({});
  const run = (action: () => Promise<ActionState>, onDone?: (s: ActionState) => void) =>
    startTransition(async () => {
      const next = await action();
      setState(next);
      if (next.ok) {
        router.refresh();
        onDone?.(next);
      }
    });
  return { pending, state, run };
}

/**
 * Comments and attachments on one Logistics or Hospitality record (Section 19.6): the main thread with
 * a composer, and files with versions and malware scan status.
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
  const t = useCollabCopy();
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
          {t("comments")}
        </h2>
        <ActionAlert state={comments.state} />
        {all.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {canPost ? t("noComments") : t("noCommentsReadOnly")}
          </p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-12 p-0">
            {all.map((c) => (
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
                  {c.editedAt ? <span>{t("edited")}</span> : null}
                </p>
                {c.deletedAt ? (
                  <p className="m-0 text-text-13 italic text-text-tertiary">{t("deleted")}</p>
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
                      {t("delete")}
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
              label={t("write")}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
            />
            <div>
              <Button type="submit" loading={comments.pending} disabled={body.trim() === ""}>
                {t("post")}
              </Button>
            </div>
          </form>
        ) : null}
      </section>
      <section aria-labelledby={`attachments-${subject.id}`} className="flex flex-col gap-12">
        <h2 id={`attachments-${subject.id}`} className="m-0 text-heading-16 font-semibold">
          {t("attachments")}
        </h2>
        <ActionAlert state={files.state} />
        {attachments.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {canPost ? t("noAttachments") : t("noAttachmentsReadOnly")}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {attachments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
                <span className="flex flex-col gap-2">
                  <span className="text-text-14">{a.title}</span>
                  <span className="text-text-12 text-text-secondary">
                    {t("version", { n: a.versions[0]?.versionNumber ?? 1 })} ·{" "}
                    {format.dateTime(new Date(a.createdAt), { dateStyle: "medium" })}
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
                    {t(`scan.${scan(a)}`)}
                  </Tag>
                  {a.current ? (
                    <Button
                      size="sm"
                      onClick={() =>
                        files.run(
                          () => attachmentLinkAction(org, subject, a.id),
                          (s) => {
                            if (s.key) window.open(s.key, "_blank", "noopener");
                          },
                        )
                      }
                    >
                      {t("download")}
                    </Button>
                  ) : null}
                  {a.createdBy === me ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => files.run(() => removeAttachmentAction(org, a.id))}
                    >
                      {t("remove")}
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
              <span className="font-medium">{t("file")}</span>
              <input ref={fileRef} name="file" type="file" required className="text-text-13" />
            </label>
            <Button type="submit" loading={files.pending}>
              {t("upload")}
            </Button>
          </form>
        ) : null}
      </section>
    </div>
  );
}
