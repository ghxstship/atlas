"use client";

import type { LiveRoom } from "@xos/data/live";
import { AvatarStack } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { loadHub } from "@/components/live/live-source";
import {
  othersEditing,
  presenceState,
  presenceTopic,
  type OtherEditor,
  type PresenceMe,
} from "@/components/presence/presence";

/**
 * Who else has this budget open, and which line each of them is editing (Section 11.7, gap G-216).
 * The grid joins the budget's presence channel presence:budgets:<id> on the tab's live hub, which
 * loads on demand (ADR 0027), and tracks the line of the cell this tab has open. Realtime admits only
 * readers of the budget (2811), and nothing shows while the person is alone or offline.
 */
export function BudgetPresence({
  budgetId,
  me,
  editingLine,
}: {
  budgetId: string;
  me: PresenceMe;
  /** The grid line of the cell this tab has open, or null. */
  editingLine: number | null;
}) {
  const t = useTranslations("collab.presence");
  const [others, setOthers] = useState<readonly OtherEditor[]>([]);
  const { key: meKey, name: meName } = me;
  const live = useRef<{ room: LiveRoom | null; joined: boolean; line: number | null }>({
    room: null,
    joined: false,
    line: null,
  });

  useEffect(() => {
    const state = live.current;
    let stopped = false;
    // Tracked after every (re)join: Realtime forgets a tab's presence when its channel drops.
    const track = () => {
      if (!state.joined) return;
      const me = { key: meKey, name: meName };
      void state.room?.track(
        state.line === null ? presenceState(me) : presenceState(me, { line: state.line }),
      );
    };
    void loadHub().then((hub) => {
      if (!hub || stopped) return;
      state.room = hub.room(
        presenceTopic("budgets", budgetId),
        { events: [], presenceKey: meKey },
        {
          onBroadcast: () => undefined,
          onPresence: (members) => setOthers(othersEditing(members, meKey)),
          onStatus: (status) => {
            state.joined = status === "joined";
            if (state.joined) track();
            else setOthers([]);
          },
        },
      );
      track();
    });
    return () => {
      stopped = true;
      state.room?.leave();
      state.room = null;
      state.joined = false;
      setOthers([]);
    };
  }, [budgetId, meKey, meName]);

  // The open line changes as the person moves between cells; the channel stays joined.
  useEffect(() => {
    const state = live.current;
    state.line = editingLine;
    if (!state.joined) return;
    const me = { key: meKey, name: meName };
    void state.room?.track(
      editingLine === null ? presenceState(me) : presenceState(me, { line: editingLine }),
    );
  }, [editingLine, meKey, meName]);

  if (others.length === 0) return null;
  return (
    <div className="flex flex-col gap-4">
      <div
        role="group"
        aria-label={t("label")}
        data-presence={presenceTopic("budgets", budgetId)}
        className="flex items-center gap-8 text-text-12 text-text-secondary"
      >
        <AvatarStack names={others.map((o) => o.name)} />
        <span>{t("viewing", { count: others.length })}</span>
      </div>
      <div role="status" className="flex flex-col gap-4 text-text-12 text-text-secondary">
        {others
          .filter((o) => o.line !== null)
          .map((o) => (
            <p key={o.name} className="m-0">
              {t("editingLine", { name: o.name, line: o.line ?? 0 })}
            </p>
          ))}
      </div>
    </div>
  );
}
