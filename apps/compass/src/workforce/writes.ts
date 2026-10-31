/**
 * Workforce Suite writes from Compass (Section 4.9). The sixteen RPCs A29 allowlisted in
 * private.sync_rpcs (0807; each SECURITY DEFINER with its own capability check, 0935), and B8's weather hold and
 * all-clear (2977), queue offline and replay once through app.apply_sync_mutation, keyed by the mutation id. The hold
 * RPCs also carry the mutation id as p_id (a replay returns the stored hold) and the device time, so a hold made
 * offline more than 10 minutes before it reaches the server is refused rather than sent late. Everything else (starting a
 * direct message, grading a quiz, opening a help desk request) needs the server's answer at once and
 * goes online through A29's repositories.
 */
import { uuidv7, type MutationInput } from "@xos/sync";
import { signaturePng } from "./signature-png";

export const WORKFORCE_SYNC_RPCS = [
  "send_chat_message",
  "mark_conversation_read",
  "acknowledge_feed_post",
  "react_to_feed_post",
  "vote_in_poll",
  "respond_to_survey",
  "rsvp_to_event",
  "check_in_to_event",
  "submit_form",
  "complete_training_lesson",
  "acknowledge_handbook_article",
  "recognize",
  "record_occupancy_count",
  "record_weather_reading",
  "check_in_guest",
  "log_lost_item",
  "call_weather_hold",
  "give_weather_all_clear",
] as const;

/** The queued RPCs that take the mutation id as p_id and the device time as p_device_at (2977). */
const STAMPED: ReadonlySet<WorkforceSyncRpc> = new Set([
  "call_weather_hold",
  "give_weather_all_clear",
]);

export type WorkforceSyncRpc = (typeof WORKFORCE_SYNC_RPCS)[number];

/** The local table each queued write belongs to, so the offline queue groups and names it. */
const TABLE: Readonly<Record<WorkforceSyncRpc, string>> = {
  send_chat_message: "chat_messages",
  mark_conversation_read: "conversation_reads",
  acknowledge_feed_post: "feed_acknowledgments",
  react_to_feed_post: "feed_reactions",
  vote_in_poll: "poll_votes",
  respond_to_survey: "survey_responses",
  rsvp_to_event: "event_rsvps",
  check_in_to_event: "event_check_ins",
  submit_form: "form_submissions",
  complete_training_lesson: "training_lesson_progress",
  acknowledge_handbook_article: "handbook_acknowledgments",
  recognize: "recognitions",
  record_occupancy_count: "occupancy_counts",
  record_weather_reading: "weather_readings",
  check_in_guest: "guest_check_ins",
  log_lost_item: "lost_found_items",
  call_weather_hold: "weather_holds",
  give_weather_all_clear: "weather_holds",
};

/** Arguments with undefined values dropped, as the repositories send them. */
function compact(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
}

/** One queued workforce RPC. Its id doubles as the row id, so a retried tap is the same mutation. */
export function workforceWrite(
  rpc: WorkforceSyncRpc,
  args: Readonly<Record<string, unknown>>,
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): MutationInput {
  const rowId = newId(nowMs);
  return {
    op: "rpc",
    target: `app.${rpc}`,
    table: TABLE[rpc],
    rowId,
    payload: STAMPED.has(rpc)
      ? { ...compact(args), p_id: rowId, p_device_at: new Date(nowMs).toISOString() }
      : compact(args),
    policy: "append",
    optimistic: null,
  };
}

export interface FormSubmissionDraft {
  readonly orgId: string;
  /** The submitter's person id: form media lives under <org_id>/forms/<person_id>/ (0808). */
  readonly personId: string;
  readonly templateId: string;
  readonly answers: Readonly<Record<string, unknown>>;
  readonly projectId: string | null;
  readonly location: { latitude: number; longitude: number; accuracyM: number } | null;
  /** The signer's name and the SVG path the person drew on the signature pad. */
  readonly signature: { signerName: string; svgPath: string } | null;
  /** Photos captured for photo fields: the object name the answers carry and the file on the device. */
  readonly photos: readonly { storagePath: string; localUri: string }[];
}

/** The field-media object name of a form photo or signature (0808). */
export function formMediaPath(orgId: string, personId: string, fileName: string): string {
  return `${orgId}/forms/${personId}/${fileName}`;
}

/**
 * Journey 65: a form filled in offline. The drawn signature becomes a PNG (field-media takes images
 * only) and travels with the captured photos as device media the uploader writes before the RPC runs;
 * the answers, GPS stamp and signer queue as one app.submit_form call, replayed once.
 */
export function buildFormSubmission(
  draft: FormSubmissionDraft,
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): MutationInput {
  const id = newId(nowMs);
  const signaturePath = draft.signature
    ? formMediaPath(draft.orgId, draft.personId, `${id}-signature.png`)
    : null;
  const media = [
    ...draft.photos.map((p) => ({ storage_path: p.storagePath, local_uri: p.localUri })),
    ...(draft.signature && signaturePath
      ? [
          {
            storage_path: signaturePath,
            local_uri: `data:image/png;base64,${encodeBase64(signaturePng(draft.signature.svgPath))}`,
          },
        ]
      : []),
  ];
  return workforceWrite(
    "submit_form",
    {
      p_template_id: draft.templateId,
      p_answers: draft.answers,
      p_project_id: draft.projectId ?? undefined,
      p_location: draft.location
        ? {
            latitude: draft.location.latitude,
            longitude: draft.location.longitude,
            accuracy_m: draft.location.accuracyM,
          }
        : undefined,
      p_signature:
        draft.signature && signaturePath
          ? { signer_name: draft.signature.signerName, signature_path: signaturePath }
          : undefined,
      // Device-only: the uploader writes each file to field-media first (SupabaseUploader).
      device_media: media.length > 0 ? media : undefined,
    },
    nowMs,
    () => id,
  );
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 of bytes without platform globals (Hermes has no Buffer). */
export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += BASE64[(n >> 18) & 63];
    out += BASE64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? BASE64[n & 63] : "=";
  }
  return out;
}

/** The bytes of base64 text. */
export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => BASE64.indexOf(clean[i + k] ?? "A"));
    const v = ((n[0] ?? 0) << 18) | ((n[1] ?? 0) << 12) | ((n[2] ?? 0) << 6) | (n[3] ?? 0);
    out.push((v >> 16) & 255);
    if (i + 2 < clean.length) out.push((v >> 8) & 255);
    if (i + 3 < clean.length) out.push(v & 255);
  }
  return new Uint8Array(out);
}
