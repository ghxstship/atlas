"use server";

import { markSeen, recordVisit } from "@xos/data/change-tracking";
import { z } from "zod";
import { toAction, type ActionResult } from "@/lib/action-result";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * The itinerary's last-seen marker (B6, ADR 0145): opening Travel and Lodging or Hospitality records a visit on the
 * engagement's itinerary once the page is on screen, and Mark all as seen moves the marker to now. A visit is a
 * 30-minute window, so a refresh never clears the highlights. The database decides whether the itinerary is the
 * person's (app.record_visit, app.mark_seen).
 */
const id = z.uuid();

export async function recordItineraryVisitAction(engagementId: string): Promise<ActionResult> {
  return toAction(
    await recordVisit(await createServerSupabase(), "Itinerary", id.parse(engagementId)),
  );
}

export async function markItinerarySeenAction(engagementId: string): Promise<ActionResult> {
  return toAction(
    await markSeen(await createServerSupabase(), "Itinerary", id.parse(engagementId)),
  );
}
