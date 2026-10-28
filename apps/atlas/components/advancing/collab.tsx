"use client";

import type { Attachment } from "@xos/data/attachments";
import type { Thread } from "@xos/data/comments";
import { Button, InlineAlert, Textarea } from "@xos/ui";
import { useFormatter } from "next-intl";
import {
  startTransition,
  useActionState,
  useId,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import type { AdvancingState } from "./actions";
import {
  attachmentLinkAction,
  deleteCommentAction,
  postCommentAction,
  removeAttachmentAction,
  uploadAttachmentAction,
} from "./collab-actions";
import { useCopy } from "./use-copy";
import { AttachmentPreview } from "@/components/files/file-preview";

interface SubjectProps {
  readonly org: string;
  readonly subjectTable: string;
  readonly subjectId: string;
}

type Action = (state: AdvancingState, form: FormData) => Promise<AdvancingState>;

/** A form posted in a transition; it remounts empty after each success and keeps input on failure. */
function useSubmit(action: Action) {
  const [state, run, pending] = useActionState<AdvancingState & { seq?: number }, FormData>(
    async (prev, form) => {
      const next = await action(prev, form);
      return { ...next, seq: (prev.seq ?? 0) + (next.ok ? 1 : 0) };
    },
    {},
  );
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => run(data));
  };
  return { state, pending, onSubmit, key: state.seq ?? 0 };
}

function Hidden({ values }: { values: Readonly<Record<string, string>> }) {
  return (
    <>
      {Object.entries(values).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

function ErrorLine({ state }: { state: AdvancingState }) {
  const t = useCopy("advancing.errors");
  return state.error ? <InlineAlert tone="danger">{t(state.error)}</InlineAlert> : null;
}

function DeleteComment({ hidden }: { hidden: Readonly<Record<string, string>> }) {
  const t = useCopy("advancing.collab");
  const { state, pending, onSubmit } = useSubmit(deleteCommentAction);
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Hidden values={hidden} />
      <div>
        <Button type="submit" variant="ghost" size="sm" loading={pending}>
          {t("deleteComment")}
        </Button>
      </div>
      <ErrorLine state={state} />
    </form>
  );
}

/** Comments on an Advancing row (Section 19.6): the main thread, oldest first, with a composer. */
export function CommentsPanel({
  org,
  subjectTable,
  subjectId,
  threads,
  names,
  me,
}: SubjectProps & {
  threads: readonly Thread[];
  names: Readonly<Record<string, string>>;
  me: string | null;
}) {
  const t = useCopy("advancing.collab");
  const format = useFormatter();
  const id = useId();
  const { state, pending, onSubmit, key } = useSubmit(postCommentAction);
  const hidden = { org, subjectTable, subjectId };
  const comments = threads.flatMap((th) => th.comments).filter((c) => !c.deletedAt);
  return (
    <section aria-labelledby={`${id}-comments`} className="flex flex-col gap-12">
      <h2 id={`${id}-comments`} className="m-0 text-heading-16 font-semibold">
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
                <DeleteComment hidden={{ ...hidden, commentId: c.id }} />
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <form key={key} onSubmit={onSubmit} className="flex flex-col gap-8" noValidate>
        <Hidden values={hidden} />
        <ErrorLine state={state} />
        <Textarea
          id={`${id}-body`}
          name="body"
          rows={3}
          maxLength={10000}
          required
          width="100%"
          label={t("newComment")}
          error={state.fieldErrors?.["body"] ? t("bodyError") : ""}
        />
        <div>
          <Button type="submit" size="sm" loading={pending}>
            {t("post")}
          </Button>
        </div>
      </form>
    </section>
  );
}

function RemoveAttachment({ hidden }: { hidden: Readonly<Record<string, string>> }) {
  const t = useCopy("advancing.collab");
  const { state, pending, onSubmit } = useSubmit(removeAttachmentAction);
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Hidden values={hidden} />
      <Button type="submit" variant="ghost" size="sm" loading={pending}>
        {t("remove")}
      </Button>
      <ErrorLine state={state} />
    </form>
  );
}

/** Attachments: clean files download through a short-lived link; uploads are virus-checked. */
export function AttachmentsPanel({
  org,
  subjectTable,
  subjectId,
  attachments,
  canUpload,
}: SubjectProps & { attachments: readonly Attachment[]; canUpload: boolean }) {
  const t = useCopy("advancing.collab");
  const id = useId();
  const [opening, start] = useTransition();
  const [problem, setProblem] = useState(false);
  const { state, pending, onSubmit, key } = useSubmit(uploadAttachmentAction);
  const hidden = { org, subjectTable, subjectId };
  const open = (attachmentId: string) =>
    start(async () => {
      const url = await attachmentLinkAction({ org, subjectTable, subjectId, attachmentId });
      setProblem(url === null);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    });
  return (
    <section aria-labelledby={`${id}-files`} className="flex flex-col gap-12">
      <h2 id={`${id}-files`} className="m-0 text-heading-16 font-semibold">
        {t("attachments")}
      </h2>
      {problem ? (
        <p role="alert" className="m-0 text-text-13 text-danger-text">
          {t("notReady")}
        </p>
      ) : null}
      {attachments.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {canUpload ? t("noAttachments") : t("noAttachmentsReadOnly")}
        </p>
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
                <AttachmentPreview attachment={a} />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!a.current || opening}
                  onClick={() => open(a.id)}
                >
                  {t("download", { title: a.title })}
                </Button>
                {canUpload ? <RemoveAttachment hidden={{ ...hidden, attachmentId: a.id }} /> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canUpload ? (
        <form key={key} onSubmit={onSubmit} className="flex flex-wrap items-end gap-8" noValidate>
          <Hidden values={hidden} />
          <div className="flex flex-col gap-4">
            <label htmlFor={`${id}-file`} className="text-text-12 font-medium text-text-secondary">
              {t("file")}
            </label>
            <input id={`${id}-file`} name="file" type="file" required className="text-text-13" />
          </div>
          <Button type="submit" size="sm" loading={pending}>
            {t("upload")}
          </Button>
          <div className="basis-full">
            <ErrorLine state={state} />
            {state.fieldErrors?.["file"] ? (
              <p role="alert" className="m-0 text-text-13 text-danger-text">
                {t(state.fieldErrors["file"] === "fileSize" ? "fileSize" : "fileError")}
              </p>
            ) : null}
            {state.ok ? (
              <p role="status" className="m-0 text-text-13 text-success-text">
                {t("uploaded")}
              </p>
            ) : null}
          </div>
        </form>
      ) : null}
    </section>
  );
}
