import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";
import type { Database } from "./database.types.ts";

/**
 * Feedback to the platform team (Section 11.7, A65-022, migration 1531). The widget in Atlas and Gateway sends the
 * message, the page context it showed the person, and an optional screenshot they chose, uploaded first through the
 * support screenshot path (uploadSupportScreenshot in workflow.ts, bucket support-screenshots, 1034). Platform staff
 * list and triage it; a screenshot opens for them only once its upload scan found it Clean.
 */

export type FeedbackApp = Database["app"]["Enums"]["shortcut_shell"];
export type FeedbackState = "New" | "Read" | "Planned" | "Closed";
export const FEEDBACK_STATES: readonly FeedbackState[] = ["New", "Read", "Planned", "Closed"];
export const FEEDBACK_TRIAGE_STATES: readonly Exclude<FeedbackState, "New">[] = [
  "Read",
  "Planned",
  "Closed",
];

/** What the widget shows the person and sends with their message: nothing else is captured. */
export interface FeedbackContext {
  /** Path of the page, without its query string. */
  readonly route: string | null;
  readonly appVersion: string | null;
  readonly locale: string | null;
  /** Window size in CSS pixels, "1280x720". */
  readonly viewport: string | null;
}

export interface FeedbackInput extends FeedbackContext {
  readonly app: FeedbackApp;
  readonly message: string;
  /** Org the person was working in; only one they belong to. */
  readonly orgId: string | null;
  /** <person_id>/<file> in support-screenshots, uploaded by the person. */
  readonly screenshotPath: string | null;
}

/** The page path the widget may send: the path alone, never a query string or fragment. */
export function feedbackRoute(pathname: string): string | null {
  const path = pathname.split(/[?#]/)[0] ?? "";
  return /^\/[^\s]*$/.test(path) && path.length <= 500 ? path : null;
}

/** Sends feedback; returns its number, FB-000001 and up. */
export async function sendFeedback(db: XosClient, input: FeedbackInput): Promise<Result<string>> {
  const { data, error } = await db.rpc("send_feedback", {
    p_app_code: input.app,
    p_message: input.message,
    ...(input.route === null ? {} : { p_route: input.route }),
    ...(input.orgId === null ? {} : { p_org_id: input.orgId }),
    ...(input.appVersion === null ? {} : { p_app_version: input.appVersion }),
    ...(input.locale === null ? {} : { p_locale: input.locale }),
    ...(input.viewport === null ? {} : { p_viewport: input.viewport }),
    ...(input.screenshotPath === null ? {} : { p_screenshot_path: input.screenshotPath }),
  });
  if (error) return fail(toDataError(error));
  return ok(String(data));
}

export interface FeedbackItem {
  readonly id: string;
  readonly number: string;
  readonly app: FeedbackApp;
  readonly message: string;
  readonly route: string | null;
  readonly appVersion: string | null;
  readonly locale: string | null;
  readonly viewport: string | null;
  readonly orgSlug: string | null;
  readonly senderName: string | null;
  readonly screenshotPath: string | null;
  /** The screenshot's upload scan: Scanning, Clean, Infected or Scan Failed; null when it has none yet. */
  readonly screenshotScan: string | null;
  readonly state: FeedbackState;
  readonly note: string | null;
  readonly triagedAt: string | null;
  readonly createdAt: string;
}

interface TriageRow {
  id: string;
  submission_number: string;
  app_code: FeedbackApp;
  message: string;
  route: string | null;
  app_version: string | null;
  locale: string | null;
  viewport: string | null;
  context_org_slug: string | null;
  sender_name: string | null;
  screenshot_path: string | null;
  screenshot_scan: string | null;
  triage_state: FeedbackState;
  triage_note: string | null;
  triaged_at: string | null;
  created_at: string;
}

/** True when the signed-in person is on the platform team. */
export async function amIPlatformStaff(db: XosClient): Promise<Result<boolean>> {
  const { data, error } = await db.rpc("am_i_platform_staff");
  if (error) return fail(toDataError(error));
  return ok(data === true);
}

/** Platform staff: feedback newest first, optionally in one state. Anyone else gets not-found. */
export async function listFeedbackForTriage(
  db: XosClient,
  state: FeedbackState | null = null,
): Promise<Result<FeedbackItem[]>> {
  const { data, error } = await db.rpc(
    "feedback_triage_list",
    state === null ? {} : { p_state: state },
  );
  if (error) return fail(toDataError(error));
  return ok(
    ((data ?? []) as TriageRow[]).map((r) => ({
      id: r.id,
      number: r.submission_number,
      app: r.app_code,
      message: r.message,
      route: r.route,
      appVersion: r.app_version,
      locale: r.locale,
      viewport: r.viewport,
      orgSlug: r.context_org_slug,
      senderName: r.sender_name,
      screenshotPath: r.screenshot_path,
      screenshotScan: r.screenshot_scan,
      state: r.triage_state,
      note: r.triage_note,
      triagedAt: r.triaged_at,
      createdAt: r.created_at,
    })),
  );
}

/** Platform staff: moves feedback to Read, Planned or Closed with an optional note. */
export async function triageFeedback(
  db: XosClient,
  input: {
    readonly id: string;
    readonly state: Exclude<FeedbackState, "New">;
    readonly note: string | null;
  },
): Promise<Result<null>> {
  const { error } = await db.rpc("triage_feedback", {
    p_id: input.id,
    p_state: input.state,
    ...(input.note === null ? {} : { p_note: input.note }),
  });
  return error ? fail(toDataError(error)) : ok(null);
}

/** Platform staff: a five-minute link to a feedback screenshot the upload scan found Clean. */
export async function feedbackScreenshotUrl(db: XosClient, path: string): Promise<Result<string>> {
  const { data, error } = await untyped(db)
    .storage.from("support-screenshots")
    .createSignedUrl(path, 300);
  if (error || !data) return fail({ kind: "not-found" });
  return ok(data.signedUrl);
}
