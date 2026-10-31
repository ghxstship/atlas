"use client";

import type { PublicCue } from "@xos/data/live-links";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DisplayScreen } from "./display-screen";
import { clockChannelName } from "@/lib/showcaller/clock-channel";

/** What the portal hands its pop-out clock: P1's DisplayScreen input, from the portal's own read. */
export interface ClockFrame {
  readonly cues: readonly PublicCue[];
  readonly name: string;
  readonly projectName: string;
  readonly brandName: string;
  readonly timeZone: string;
  readonly serverNow: string;
}

/** With no portal open, the clock reads on its own this often. */
const SELF_PULL_MS = 15_000;

/**
 * The pop-out clock of a showcaller portal (B3, ADR 0142): P1's display screen in Room Clock or Presenter Timer.
 * It takes each read the portal makes through a BroadcastChannel, so an open portal and its clock cost one read;
 * when no frame came for a pull's length (the portal was closed), it rereads the page itself every 15 seconds.
 */
export function ShowcallerClock({ token, initial }: { token: string; initial: ClockFrame }) {
  const router = useRouter();
  // The portal's latest frame, else the clock's own read; whichever the database answered later wins.
  const [fromPortal, setFromPortal] = useState<ClockFrame | null>(null);
  const frame =
    fromPortal && Date.parse(fromPortal.serverNow) >= Date.parse(initial.serverNow)
      ? fromPortal
      : initial;
  useEffect(() => {
    let last = Date.now();
    const channel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel(clockChannelName(token));
    if (channel) {
      channel.onmessage = (event: MessageEvent<ClockFrame>) => {
        last = Date.now();
        setFromPortal(event.data);
      };
    }
    const timer = setInterval(() => {
      if (Date.now() - last >= SELF_PULL_MS) {
        last = Date.now();
        router.refresh();
      }
    }, SELF_PULL_MS);
    return () => {
      clearInterval(timer);
      channel?.close();
    };
  }, [router, token]);
  return (
    <DisplayScreen
      cues={frame.cues}
      name={frame.name}
      projectName={frame.projectName}
      brandName={frame.brandName}
      timeZone={frame.timeZone}
      defaultMode="Room Clock"
      serverNow={frame.serverNow}
    />
  );
}
