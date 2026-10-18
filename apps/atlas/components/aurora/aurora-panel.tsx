"use client";

import { createAuroraClient } from "@xos/ai/client";
import { AuroraConversation, type SuggestionView, type Turn } from "@xos/ai/conversation";
import {
  Button,
  Drawer,
  EmptyState,
  ErrorState,
  InlineAlert,
  Link,
  RefusalNotice,
  Skeleton,
  Tag,
  Textarea,
} from "@xos/ui";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
} from "react";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const QUESTION_ID = "aurora-question";

export interface AuroraPanelProps {
  readonly org: string;
  readonly canManage: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * The Aurora side panel, loaded the first time the person opens it (A24-009). It stays mounted
 * afterwards, so the conversation survives closing and reopening the panel.
 */
export function AuroraPanel({ org, canManage, open, onOpenChange }: AuroraPanelProps) {
  const t = useTranslations("aurora") as unknown as Translate;
  const conversation = useMemo(
    () => new AuroraConversation(createAuroraClient({ baseUrl: "/api/v1" })),
    [],
  );
  const state = useSyncExternalStore(
    conversation.subscribe,
    conversation.getSnapshot,
    conversation.getSnapshot,
  );

  useEffect(() => {
    if (open) void conversation.loadStatus();
  }, [open, conversation]);

  return (
    <Drawer title={t("panel.title")} open={open} onOpenChange={onOpenChange}>
      <div className="flex h-full flex-col gap-12">
        <p className="m-0 text-text-12 text-text-secondary">
          {t("panel.aiNotice")} <Link href="/legal/ai-features-notice">{t("panel.notice")}</Link>
        </p>
        <AuroraBody
          org={org}
          canManage={canManage}
          conversation={conversation}
          state={state}
          t={t}
        />
      </div>
    </Drawer>
  );
}

function AuroraBody({
  org,
  canManage,
  conversation,
  state,
  t,
}: {
  org: string;
  canManage: boolean;
  conversation: AuroraConversation;
  state: ReturnType<AuroraConversation["getSnapshot"]>;
  t: Translate;
}) {
  const router = useRouter();
  const go = (path: string) => router.push(path as Route);
  const a = state.availability;
  if (a.kind === "loading") {
    return (
      <div className="flex flex-col gap-8" aria-busy="true">
        <p role="status" className="m-0 text-text-13 text-text-secondary">
          {t("panel.loadingStatus")}
        </p>
        <Skeleton height={16} />
        <Skeleton height={16} width="60%" />
      </div>
    );
  }
  if (a.kind === "error") {
    return (
      <ErrorState
        title={t("statusError.title")}
        sentence={t("statusError.sentence")}
        actionLabel={t("statusError.retry")}
        onRetry={() => void conversation.loadStatus()}
      />
    );
  }
  if (a.kind === "not-in-plan") {
    return (
      <RefusalNotice
        outcome="REFUSE"
        title={t("notInPlan.title")}
        reason={t("notInPlan.reason")}
        actionLabel={t("notInPlan.action")}
        onAction={() => go(`/${org}/settings/billing-and-plan`)}
      />
    );
  }
  if (a.kind === "limit-reached") {
    return (
      <RefusalNotice
        outcome="REFUSE"
        title={t("limit.title")}
        reason={t("limit.reason", { allowance: a.allowance })}
        actionLabel={t("limit.action")}
        onAction={() => go(`/${org}/settings/billing-and-plan`)}
      />
    );
  }
  if (a.kind === "off") {
    return canManage ? (
      <EmptyState
        icon="Sparkles"
        sentence={t("off.sentence")}
        actionLabel={t("off.actionAdmin")}
        onAction={() => go(`/${org}/settings/ai-features`)}
      />
    ) : (
      <InlineAlert tone="info" title={t("off.sentence")}>
        {t("off.actionMember")}
      </InlineAlert>
    );
  }
  return <Conversation conversation={conversation} turns={state.turns} busy={state.busy} t={t} />;
}

function Conversation({
  conversation,
  turns,
  busy,
  t,
}: {
  conversation: AuroraConversation;
  turns: readonly Turn[];
  busy: boolean;
  t: Translate;
}) {
  const [question, setQuestion] = useState("");
  const focusInput = useCallback(() => document.getElementById(QUESTION_ID)?.focus(), []);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const q = question;
    setQuestion("");
    void conversation.ask(q).then(focusInput);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) submit(event);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-12">
      <div
        role="log"
        aria-live="polite"
        className="flex min-h-0 flex-1 flex-col gap-16 overflow-y-auto"
      >
        {turns.length === 0 ? (
          <EmptyState
            icon="MessageSquare"
            sentence={t("empty.sentence")}
            actionLabel={t("empty.action")}
            onAction={focusInput}
          />
        ) : (
          turns.map((turn) => (
            <TurnView key={turn.id} turn={turn} conversation={conversation} t={t} />
          ))
        )}
      </div>
      <form onSubmit={submit} className="flex flex-col gap-8 border-t border-border-subtle pt-12">
        <Textarea
          id={QUESTION_ID}
          label={t("panel.inputLabel")}
          help={t("panel.inputHelp")}
          value={question}
          rows={3}
          width="100%"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="flex flex-wrap justify-between gap-8">
          <Button
            type="button"
            variant="ghost"
            disabled={turns.length === 0 || busy}
            onClick={() => conversation.clear()}
          >
            {t("panel.newConversation")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            icon="Send"
            loading={busy}
            disabled={question.trim() === ""}
          >
            {t("panel.send")}
          </Button>
        </div>
      </form>
    </div>
  );
}

function TurnView({
  turn,
  conversation,
  t,
}: {
  turn: Turn;
  conversation: AuroraConversation;
  t: Translate;
}) {
  return (
    <article className="flex flex-col gap-8" aria-label={turn.question}>
      <p className="m-0 self-end rounded-md bg-surface-2 px-12 py-8 text-text-13">
        <span className="sr-only">{t("panel.you")}: </span>
        {turn.question}
      </p>
      <TurnAnswer turn={turn} t={t} />
      {turn.suggestions.length > 0 ? (
        <section className="flex flex-col gap-8" aria-label={t("suggestions.heading")}>
          <h3 className="m-0 text-text-13 font-semibold">{t("suggestions.heading")}</h3>
          {turn.suggestions.map((s) => (
            <SuggestionCard
              key={s.id}
              view={s}
              onConfirm={() =>
                void conversation.confirm(turn.id, s.id, t("suggestions.confirmReason"))
              }
              onReject={() =>
                void conversation.reject(turn.id, s.id, t("suggestions.rejectReason"))
              }
              t={t}
            />
          ))}
        </section>
      ) : null}
    </article>
  );
}

function TurnAnswer({ turn, t }: { turn: Turn; t: Translate }) {
  switch (turn.phase) {
    case "asking":
      return (
        <div className="flex flex-col gap-8" aria-busy="true">
          <p role="status" className="m-0 text-text-13 text-text-secondary">
            {t("panel.asking")}
          </p>
          <Skeleton height={14} />
          <Skeleton height={14} width="70%" />
        </div>
      );
    case "no-answer":
      return (
        <RefusalNotice
          outcome="NO_ANSWER"
          title={t("noAnswer.title")}
          reason={turn.missing ?? ""}
        />
      );
    case "refused":
      return (
        <RefusalNotice
          outcome="REFUSE"
          title={t("refused.title")}
          reason={turn.problem?.detail ?? ""}
        />
      );
    case "failed":
      return (
        <InlineAlert tone="danger" title={t("failed.title")}>
          {t("failed.sentence")}
        </InlineAlert>
      );
    case "error":
      return (
        <InlineAlert tone="danger" title={t("error.title")}>
          {t("error.sentence")}
        </InlineAlert>
      );
    case "answered":
      return (
        <div className="flex flex-col gap-8">
          <div className="flex flex-wrap items-center gap-8">
            <Tag tone="accent">{t("panel.aiLabel")}</Tag>
            {turn.model ? (
              <span className="text-text-11 text-text-tertiary">
                {t("panel.modelLabel", { model: turn.model })}
              </span>
            ) : null}
          </div>
          <p className="m-0 whitespace-pre-wrap text-text-13">{turn.answer?.text}</p>
          {turn.answer && turn.answer.citations.length > 0 ? (
            <div>
              <h4 className="m-0 text-text-12 font-semibold text-text-secondary">
                {t("panel.citations")}
              </h4>
              <ul className="m-0 flex flex-wrap gap-8 p-0">
                {turn.answer.citations.map((c) => (
                  <li key={`${c.path}-${c.id}`} className="list-none">
                    <Tag tone="neutral">{c.label}</Tag>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      );
  }
}

function SuggestionCard({
  view,
  onConfirm,
  onReject,
  t,
}: {
  view: SuggestionView;
  onConfirm: () => void;
  onReject: () => void;
  t: Translate;
}) {
  const format = useFormatter();
  const s = view.suggestion;
  return (
    <div className="flex flex-col gap-8 rounded-md border border-border-subtle p-12">
      <div className="flex flex-wrap items-center gap-8">
        <Tag tone="accent">{t("panel.aiLabel")}</Tag>
        <span className="text-text-11 text-text-tertiary">{t("suggestions.provenance")}</span>
      </div>
      <p className="m-0 text-text-13">{view.summary}</p>
      <p className="m-0 text-text-11 text-text-tertiary">
        {t("suggestions.operation", { operation: view.operationId })}
      </p>
      {view.phase === "loading" ? (
        <p role="status" className="m-0 text-text-12 text-text-secondary">
          {t("suggestions.loading")}
        </p>
      ) : null}
      {s && s.proposed_fields.length > 0 ? (
        <table className="w-full border-collapse text-start text-text-12">
          <caption className="sr-only">{t("suggestions.caption")}</caption>
          <thead>
            <tr className="text-text-secondary">
              <th scope="col" className="py-4 text-start font-medium">
                {t("suggestions.field")}
              </th>
              <th scope="col" className="py-4 text-start font-medium">
                {t("suggestions.value")}
              </th>
              <th scope="col" className="py-4 text-end font-medium">
                {t("suggestions.confidence")}
              </th>
            </tr>
          </thead>
          <tbody>
            {s.proposed_fields.map((f) => (
              <tr key={f.field_path} className="border-t border-border-subtle align-top">
                <th scope="row" className="py-4 text-start font-mono font-normal">
                  {f.field_path}
                </th>
                <td className="py-4">
                  {f.refusal === "NO_ANSWER"
                    ? t("suggestions.noAnswerValue", { missing: f.missing ?? "" })
                    : typeof f.proposed_value === "string"
                      ? f.proposed_value
                      : JSON.stringify(f.proposed_value)}
                </td>
                <td className="py-4 text-end tabular-nums">
                  {f.confidence === null
                    ? ""
                    : t("suggestions.confidenceValue", { percent: Math.round(f.confidence * 100) })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {s && view.phase === "proposed" ? (
        <p className="m-0 text-text-11 text-text-tertiary">
          {t("suggestions.expires", {
            date: format.dateTime(new Date(s.expires_at), {
              dateStyle: "medium",
              timeStyle: "short",
            }),
          })}
        </p>
      ) : null}
      {view.phase === "applied" ? (
        <p role="status" className="m-0 text-text-12 text-success-text">
          {t("suggestions.applied")}
        </p>
      ) : null}
      {view.phase === "rejected" ? (
        <p role="status" className="m-0 text-text-12 text-text-secondary">
          {t("suggestions.rejected")}
        </p>
      ) : null}
      {view.phase === "refused" ? (
        <InlineAlert tone="warning">
          {t("suggestions.refused", { detail: view.problem?.detail ?? "" })}
        </InlineAlert>
      ) : null}
      {view.phase === "error" ? (
        <InlineAlert tone="danger">
          {t("suggestions.error", { detail: view.problem?.detail ?? "" })}
        </InlineAlert>
      ) : null}
      {view.phase === "proposed" || view.phase === "refused" || view.phase === "confirming" ? (
        <div className="flex flex-wrap gap-8">
          <Button
            variant="primary"
            icon="Check"
            loading={view.phase === "confirming"}
            disabled={view.phase !== "proposed" && view.phase !== "refused"}
            onClick={onConfirm}
          >
            {t("suggestions.confirm")}
          </Button>
          <Button
            variant="ghost"
            icon="X"
            disabled={view.phase === "confirming"}
            onClick={onReject}
          >
            {t("suggestions.reject")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
