/**
 * Uploader routes for settings writes that are not RPCs (ADR 0071). A party preference is a row of
 * app.person_notification_preferences that Gateway updates or adds (setMyNotificationPreference, migration 1131); a
 * queued one runs the same function when it is sent, as the person, so owner-only row level security decides.
 * Setting the same choice twice leaves the same row, so a retried send is harmless.
 */
import type { XosClient } from "@xos/data";
import {
  PARTY_CATEGORIES,
  PARTY_CHANNELS,
  setMyNotificationPreference,
  type PartyCategory,
  type PartyChannel,
} from "@xos/data/party-notifications";
import type { Mutation, UploadOutcome } from "@xos/sync";
import { PARTY_PREFERENCE_TARGET } from "../settings/notifications";
import { outcomeFromResult, type Route } from "./uploader";

const isCategory = (value: unknown): value is PartyCategory =>
  (PARTY_CATEGORIES as readonly unknown[]).includes(value);
const isChannel = (value: unknown): value is PartyChannel =>
  (PARTY_CHANNELS as readonly unknown[]).includes(value);

/** Sends one queued party preference; a payload that is not one is refused, never sent. */
export function partyPreferenceRoute(db: XosClient): Route {
  return async (mutation: Mutation): Promise<UploadOutcome> => {
    const { person_id: personId, category, channel, enabled } = mutation.payload;
    if (
      typeof personId !== "string" ||
      !isCategory(category) ||
      !isChannel(channel) ||
      typeof enabled !== "boolean"
    ) {
      return {
        kind: "refused",
        error: {
          code: "invalid",
          message: "This notification choice is not one Compass can send.",
        },
      };
    }
    return outcomeFromResult(
      await setMyNotificationPreference(db, { personId, category, channel, enabled }),
    );
  };
}

/** The settings routes the uploader sends by target. */
export function settingsRoutes(db: XosClient): Readonly<Record<string, Route>> {
  return { [PARTY_PREFERENCE_TARGET]: partyPreferenceRoute(db) };
}
