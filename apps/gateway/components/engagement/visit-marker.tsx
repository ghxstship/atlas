"use client";

import { useEffect, useRef } from "react";
import type { ActionResult } from "@/lib/action-result";

/**
 * Records a visit to the itinerary once the tab is on screen (B6). It runs after mount, never during a render or a
 * prefetch, so a link the person only hovered never moves their last-seen marker. Renders nothing.
 */
export function VisitMarker({ record }: { record: () => Promise<ActionResult> }) {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    void record();
  }, [record]);
  return null;
}
