"use client";

import type { LiveRoom } from "@xos/data/live";
import { AvatarStack } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { loadHub } from "@/components/live/live-source";
import {
  othersPresent,
  presenceState,
  presenceTopic,
  type PresenceMe,
  type PresenceTable,
} from "./presence";

/**
 * Joins a row's presence channel on the tab's live hub and shows who else is there, loaded on
 * demand by RecordPresence (ADR 0027). Nothing shows while the person is alone, offline, or not
 * allowed on the channel (Realtime refuses a join by anyone who cannot read the row).
 */
export function PresenceRoom({
  table,
  id,
  me,
}: {
  table: PresenceTable;
  id: string;
  me: PresenceMe;
}) {
  const t = useTranslations("collab.presence");
  const [others, setOthers] = useState<readonly string[]>([]);
  const { key: meKey, name: meName } = me;

  useEffect(() => {
    const live: { room: LiveRoom | null; joined: boolean; stopped: boolean } = {
      room: null,
      joined: false,
      stopped: false,
    };
    // Tracked after every (re)join: Realtime forgets a tab's presence when its channel drops.
    const track = () => {
      if (live.joined) void live.room?.track(presenceState({ key: meKey, name: meName }));
    };
    void loadHub().then((hub) => {
      if (!hub || live.stopped) return;
      live.room = hub.room(
        presenceTopic(table, id),
        { events: [], presenceKey: meKey },
        {
          onBroadcast: () => undefined,
          onPresence: (members) => setOthers(othersPresent(members, meKey)),
          onStatus: (status) => {
            live.joined = status === "joined";
            if (live.joined) track();
            else setOthers([]);
          },
        },
      );
      track();
    });
    return () => {
      live.stopped = true;
      live.room?.leave();
      setOthers([]);
    };
  }, [table, id, meKey, meName]);

  if (others.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={t("label")}
      data-presence={presenceTopic(table, id)}
      className="flex items-center gap-8 text-text-12 text-text-secondary"
    >
      <AvatarStack names={[...others]} />
      <span>{t("viewing", { count: others.length })}</span>
    </div>
  );
}
