"use client";

import { useEffect, useRef } from "react";
import type { SeenSurface } from "@xos/data/change-tracking";
import { recordVisitAction } from "@/lib/change-tracking/actions";

/**
 * Records a visit to Today or a Show day once the page is on screen (B6). It runs after mount, never
 * during a render or a prefetch, so a link the person only hovered never moves their last-seen
 * marker. Renders nothing.
 */
export function VisitMarker({ surface, scopeId }: { surface: SeenSurface; scopeId: string }) {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    void recordVisitAction(surface, scopeId);
  }, [surface, scopeId]);
  return null;
}
