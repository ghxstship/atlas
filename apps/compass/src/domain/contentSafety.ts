/**
 * Reporting and blocking in Compass (owner decision 19, App Store Review Guideline 1.2). A post, message or
 * shout-out by someone else opens the content safety sheet (screens/ContentSafetySheet.tsx): report it to the org's
 * moderators, who decide within 24 hours in Atlas, or block its author, which hides their posts, comments, shout-outs
 * and messages from this person everywhere they read them (migration 1631). Both need the server's answer, so both
 * go online; Settings, Blocked People lifts a block.
 */
import {
  CONTENT_REPORT_REASONS,
  REPORT_RESPONSE_HOURS,
  type ContentReportReason,
} from "@xos/data/content-safety";
import type { ContentActionTarget } from "@xos/workforce-native";

export { CONTENT_REPORT_REASONS, REPORT_RESPONSE_HOURS };

/** The test id of the button on each item that opens the sheet; Compass hands it to the Workforce screens. */
export const CONTENT_ACTIONS_TEST_ID = "content-actions";

/** What the item is, for the sheet's copy: a post, a chat message or a shout-out (reported as its feed post). */
export type ContentNoun = "post" | "message" | "shoutOut";

/** The catalog key of each reason under compass.safety.reasons. */
export const REASON_KEYS: Readonly<Record<ContentReportReason, string>> = {
  Harassment: "harassment",
  Hate: "hate",
  "Sexual Content": "sexualContent",
  Violence: "violence",
  Spam: "spam",
  Other: "other",
};

/** The test id of each reason's button, written out so Maestro flows can name them. */
export const REASON_TEST_IDS: Readonly<Record<ContentReportReason, string>> = {
  Harassment: "report-reason-harassment",
  Hate: "report-reason-hate",
  "Sexual Content": "report-reason-sexual-content",
  Violence: "report-reason-violence",
  Spam: "report-reason-spam",
  Other: "report-reason-other",
};

/** The catalog key suffix for a noun (compass.safety.reportPost, actionsMessage, ...). */
export function nounKey(noun: ContentNoun): "Post" | "Message" | "ShoutOut" {
  return noun === "post" ? "Post" : noun === "message" ? "Message" : "ShoutOut";
}

/** Whether the sheet can offer Block: a block names the author's membership. */
export function canBlock(target: ContentActionTarget): boolean {
  return target.authorMembershipId !== null;
}

/** The longest details a report takes (app.content_reports.details). */
export const REPORT_DETAILS_MAX = 2000;

/** The steps of the sheet. */
export type SafetyStep = "menu" | "report" | "reported" | "confirm-block" | "blocked";

/** Where the sheet opens: straight on Report when Block is not possible, else on the choice of the two. */
export function firstStep(target: ContentActionTarget): SafetyStep {
  return canBlock(target) ? "menu" : "report";
}
