"use client";

import type { Thread } from "@xos/data/comments";
import { Button, InlineAlert, Tag, Textarea } from "@xos/ui";
import { useFormatter } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { postPlanCommentAction, setThreadResolvedAction } from "@/app/[org]/places/plan-actions";
import { useCopy } from "../kit/form";

export type PlanThreadSubject =
  | {
      readonly table: "app.site_plan_pins" | "app.site_plan_shapes";
      readonly id: string;
      readonly anchor: null;
    }
  | { readonly table: "app.site_plans"; readonly id: string; readonly anchor: string };

/**
 * The thread of a pin, a shape or a point note (G-18, ADR 0140 D5): replies, @mention of the people on the plan's
 * project, and Resolve. It reuses the one comment system (0580), so mentions reach only people who can open the
 * project, and a reply to a resolved point note reopens it. Comments are allowed in every plan state.
 */
export function PlanThread({
  org,
  title,
  subject,
  thread,
  names,
  people,
  canPost,
}: {
  org: string;
  title: string;
  subject: PlanThreadSubject;
  thread: Thread | null;
  names: Readonly<Record<string, string>>;
  people: readonly { readonly id: string; readonly name: string }[];
  canPost: boolean;
}) {
  const t = useCopy("places");
  const format = useFormatter();
  const router = useRouter();
  const [body, setBody] = useState("");
  const [mentions, setMentions] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = (action: () => Promise<{ ok: boolean; error?: string }>, done?: () => void) =>
    start(async () => {
      setError(null);
      const result = await action();
      if (result.ok) {
        done?.();
        router.refresh();
      } else setError(result.error ?? "unexpected");
    });
  const comments = thread?.comments ?? [];
  return (
    <section aria-labelledby="plan-thread-heading" className="flex flex-col gap-12">
      <div className="flex flex-wrap items-center justify-between gap-8">
        <h3 id="plan-thread-heading" className="m-0 text-text-14 font-semibold">
          {title}
        </h3>
        {thread?.resolvedAt ? <Tag tone="success">{t("plans.notes.resolved")}</Tag> : null}
      </div>
      {error ? (
        <InlineAlert tone="danger" title={t("errors.title")}>
          {t(`errors.${error}`)}
        </InlineAlert>
      ) : null}
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
              <p className="m-0 whitespace-pre-wrap text-text-14">
                {c.deletedAt ? t("collab.deleted") : c.body}
              </p>
              {c.mentionedPersonIds.length > 0 ? (
                <p className="m-0 text-text-12 text-text-secondary">
                  {t("plans.notes.mentioned", {
                    names: c.mentionedPersonIds
                      .map((p) => names[p] ?? "")
                      .filter(Boolean)
                      .join(", "),
                  })}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {thread && canPost ? (
        <div>
          <Button
            size="sm"
            variant="secondary"
            loading={pending}
            onClick={() =>
              run(() => setThreadResolvedAction(org, thread.id, thread.resolvedAt === null))
            }
          >
            {t(thread.resolvedAt ? "plans.notes.reopen" : "plans.notes.resolve")}
          </Button>
        </div>
      ) : null}
      {canPost ? (
        <form
          className="flex flex-col gap-8"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () => postPlanCommentAction(org, subject, body, mentions),
              () => {
                setBody("");
                setMentions([]);
              },
            );
          }}
        >
          <Textarea
            id={`plan-comment-${subject.id}`}
            label={t(comments.length > 0 ? "plans.notes.reply" : "collab.write")}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            width="100%"
          />
          {people.length > 0 ? (
            <fieldset className="m-0 flex flex-wrap gap-12 border-0 p-0">
              <legend className="mb-4 text-text-13 font-semibold">
                {t("plans.notes.mention")}
              </legend>
              {people.map((p) => (
                <label key={p.id} className="flex min-h-24 items-center gap-4 text-text-13">
                  <input
                    type="checkbox"
                    checked={mentions.includes(p.id)}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      setMentions((m) => (on ? [...m, p.id] : m.filter((x) => x !== p.id)));
                    }}
                  />
                  {t("plans.notes.mentionName", { name: p.name })}
                </label>
              ))}
            </fieldset>
          ) : null}
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
