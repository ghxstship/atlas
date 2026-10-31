"use client";

import type { ChatMessage } from "@xos/data/workforce-chat";
import { Button, InlineAlert, Tag, Textarea, useLive } from "@xos/ui";
import { useFormatter } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { ActionErrorAlert, useAction, useCopy } from "@/components/work/action-ui";
import type { ActionError } from "@/components/work/action-result";
import {
  joinShowChannelAction,
  loadShowChannelAction,
  openShowChannelAction,
  sendShowChannelMessageAction,
  type ShowChannelView,
} from "./depth-actions";
import { showChannelComposerId } from "./show-channel-ids";

/** New messages arrive within a second or two; a burst rereads once. */
const CHAT_PACING = { batchMs: 150, minIntervalMs: 500, maxIntervalMs: 2_000 } as const;

/**
 * The show channel beside the running cue (B3, G-79, ADR 0142): the project's crew chat, which Clients are never
 * in. runs.tsx loads it with next/dynamic in live mode. It asks app.show_channel_status what to offer (group
 * visibility hides a group from people outside it), shows the last 50 messages and the unread count, and rereads
 * them through a server action whenever Realtime reports a change to the conversation's messages, so the running
 * order's page itself never refreshes for a message and P2's live hold is untouched.
 *
 * The panel sits beside the showcaller console, not in it, and the show keys answer only in the console, so no key
 * pressed here calls or stands by a cue: S, J or Space typed in the composer are letters, and the shell leaves typing
 * alone as in every field (its Mod+K still opens the command menu). The console's show.chat shortcut (M) focuses the
 * composer.
 */
export function ShowChannelPanel({ org, projectId }: { org: string; projectId: string }) {
  const t = useCopy("show");
  const format = useFormatter();
  const action = useAction();
  const [view, setView] = useState<ShowChannelView | null>(null);
  const [loadError, setLoadError] = useState<ActionError | null>(null);
  const [draft, setDraft] = useState("");

  const reload = useCallback(() => {
    void loadShowChannelAction(org, projectId).then((result) => {
      if (result.ok) {
        setView(result.data);
        setLoadError(null);
      } else {
        setLoadError(result.error);
      }
    });
  }, [org, projectId]);
  useEffect(reload, [reload]);

  const conversationId = view?.status.conversationId ?? null;
  useLive(
    conversationId
      ? [{ table: "chat_messages", filter: `conversation_id=eq.${conversationId}` }]
      : null,
    reload,
    CHAT_PACING,
  );

  const headingId = `show-channel-${projectId}`;
  const status = view?.status;
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-12 rounded-card border border-border-subtle p-12"
    >
      <div className="flex flex-wrap items-center justify-between gap-8">
        <h3 id={headingId} className="m-0 text-label-13 font-semibold">
          {t("showChannel.title")}
        </h3>
        {view && view.unread > 0 ? (
          <Tag tone="accent">{t("showChannel.unread", { count: view.unread })}</Tag>
        ) : null}
      </div>
      <p className="m-0 text-text-12 text-text-secondary">{t("showChannel.clientsNever")}</p>
      <ActionErrorAlert error={loadError ?? action.error} />

      {status && !status.isMember ? (
        status.canOpen ? (
          <div>
            <Button
              variant="primary"
              loading={action.pending}
              onClick={() => action.run(() => openShowChannelAction(org, projectId), reload)}
            >
              {t("showChannel.open")}
            </Button>
          </div>
        ) : status.canJoin ? (
          <div>
            <Button
              variant="secondary"
              loading={action.pending}
              onClick={() => action.run(() => joinShowChannelAction(org, projectId), reload)}
            >
              {t("showChannel.join")}
            </Button>
          </div>
        ) : (
          <InlineAlert tone="info">
            {status.exists ? t("showChannel.notMember") : t("showChannel.none")}
          </InlineAlert>
        )
      ) : null}

      {conversationId ? (
        <>
          {view && view.messages.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("showChannel.empty")}</p>
          ) : (
            <ol
              aria-label={t("showChannel.messages")}
              className="m-0 flex max-h-96 list-none flex-col gap-8 overflow-y-auto p-0"
            >
              {(view?.messages ?? []).map((m: ChatMessage) => (
                <li key={m.id} className="flex flex-col gap-2">
                  <span className="text-text-12 text-text-secondary">
                    {t("showChannel.byline", {
                      name: m.authorName ?? t("showChannel.someone"),
                      time: format.dateTime(new Date(m.createdAt), { timeStyle: "short" }),
                    })}
                  </span>
                  <span className="whitespace-pre-wrap text-text-14">{m.body ?? ""}</span>
                </li>
              ))}
            </ol>
          )}
          <form
            className="flex flex-col gap-8"
            onSubmit={(e) => {
              e.preventDefault();
              const body = draft.trim();
              if (body === "") return;
              action.run(
                () => sendShowChannelMessageAction(org, conversationId, body),
                () => {
                  setDraft("");
                  reload();
                },
              );
            }}
          >
            <Textarea
              id={showChannelComposerId(projectId)}
              label={t("showChannel.composer")}
              rows={2}
              maxLength={4000}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div>
              <Button
                type="submit"
                size="sm"
                disabled={draft.trim() === ""}
                loading={action.pending}
              >
                {t("showChannel.send")}
              </Button>
            </div>
          </form>
        </>
      ) : null}
    </section>
  );
}
