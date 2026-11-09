"use client";

import type { LiveRoom } from "@xos/data/live";
import { useLive } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent } from "react";
import { useLiveRefresh } from "@/components/live/live-refresh";
import { loadHub } from "@/components/live/live-source";

/** Show mode follows cue calls within half a second (Section 11.11): small batches, short gaps. */
const SHOW_PACING = { batchMs: 30, minIntervalMs: 200, maxIntervalMs: 1_000 } as const;

/**
 * Follows cue calls live while mounted (ADR 0044): a called cue refreshes the page as soon as
 * Realtime reports it, and `onCalled` hears the call first, so the page can show it before the
 * reread lands (ADR 0119). The call comes on the running order's private channel show:<run id>,
 * which the database sends to without Realtime's change poll (migration 6900), and again in the
 * cue's own row, whichever arrives first. A 15-second pull covers a dropped channel; it replaced a
 * 2-second poll.
 */
export function LiveCues({
  runId,
  onCalled,
}: {
  runId: string;
  onCalled: (cueId: string, calledAt: string) => void;
}) {
  const router = useRouter();
  const topics = [{ table: "cues", filter: `run_of_show_id=eq.${runId}` }];
  useLiveRefresh(topics, SHOW_PACING);
  useLive(
    topics,
    (changes) => {
      for (const change of changes) {
        const calledAt = change.row?.["called_at"];
        if (change.type === "UPDATE" && change.id && typeof calledAt === "string") {
          onCalled(change.id, calledAt);
        }
      }
    },
    SHOW_PACING,
  );
  // The latest onCalled, so the channel joins once per running order rather than on every render.
  const heard = useEffectEvent(onCalled);
  useEffect(() => {
    let room: LiveRoom | null = null;
    let stopped = false;
    void loadHub().then((hub) => {
      if (!hub || stopped) return;
      room = hub.room(
        `show:${runId}`,
        { events: ["called"], presenceKey: runId },
        {
          onBroadcast: (_event, payload) => {
            const { cue_id: cueId, called_at: calledAt } = payload;
            if (typeof cueId === "string" && typeof calledAt === "string") {
              heard(cueId, calledAt);
            }
          },
        },
      );
    });
    return () => {
      stopped = true;
      room?.leave();
    };
  }, [runId]);
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(timer);
  }, [router]);
  return null;
}
