/**
 * The person's certifications and documents on the Compass Profile (A109, Section 4.3 item 13). They come from
 * api_external.my_profile_certifications and api_external.my_profile_documents (1730) through the REST downloader, so the
 * Profile reads them from the device and shows them offline.
 *
 * Expiry follows A89's reminder job (private.send_expiry_reminders, 1463; ADR 0045 section 7). Days left count on each
 * row's own calendar: the org's for an org item, the person's own for a profile certification or the passport, as the
 * views name it. The thresholds are 30, 7 and 1 days, and an item is at the smallest threshold its days left have
 * reached, as private.expiry_threshold reckons it, so the callout names the same stage the reminder did.
 */
import type { AttachmentVersion } from "@xos/data/attachments";
import type { Row } from "@xos/sync";
import { daysUntil, todayOn } from "./dates";

/** The reminder thresholds, in days before expiry (private.expiry_reminder_thresholds). */
export const EXPIRY_THRESHOLDS = [30, 7, 1] as const;
export type ExpiryThreshold = (typeof EXPIRY_THRESHOLDS)[number];

/**
 * The threshold an item with this many days left has reached: the smallest at or above the days left. Null once it
 * has expired or while it is further out than the first threshold (private.expiry_threshold, 1463).
 */
export function expiryThreshold(daysLeft: number): ExpiryThreshold | null {
  if (!Number.isInteger(daysLeft) || daysLeft < 0) return null;
  const reached = EXPIRY_THRESHOLDS.filter((t) => t >= daysLeft);
  return reached.length > 0 ? (Math.min(...reached) as ExpiryThreshold) : null;
}

export type ExpiryStanding =
  | { readonly kind: "none" }
  | { readonly kind: "current"; readonly daysLeft: number }
  | { readonly kind: "expiring"; readonly daysLeft: number; readonly threshold: ExpiryThreshold }
  | { readonly kind: "expired" };

/** Where an expiry date stands on a calendar whose today is given (YYYY-MM-DD). */
export function expiryStanding(expiresOn: string | null, today: string): ExpiryStanding {
  if (!expiresOn) return { kind: "none" };
  const daysLeft = daysUntil(expiresOn, today);
  if (daysLeft < 0) return { kind: "expired" };
  const threshold = expiryThreshold(daysLeft);
  return threshold === null
    ? { kind: "current", daysLeft }
    : { kind: "expiring", daysLeft, threshold };
}

/** Today on a row's calendar: its zone when it names one, else the person's own zone. */
export function todayFor(
  timeZone: string | null,
  personZone: string,
  now: Date = new Date(),
): string {
  return todayOn(timeZone ?? personZone, now);
}

// Rows ------------------------------------------------------------------------------------------------------------------

export interface ProfileCertification {
  readonly id: string;
  /** An org's holder record, or an entry on the person's own profile. */
  readonly source: "Org Record" | "Profile";
  readonly name: string;
  readonly issuingBody: string;
  readonly expiresOn: string | null;
  readonly verified: boolean;
  /** The org that recorded or verified it. */
  readonly verifiedBy: string | null;
  readonly timeZone: string | null;
}

export type ProfileDocumentType = "Engagement Document" | "Insurance Certificate" | "Passport";

/** The file a document opens: its newest clean Public or Internal attachment version. */
export type ProfileDocumentFile = Pick<
  AttachmentVersion,
  | "id"
  | "versionNumber"
  | "objectName"
  | "filename"
  | "contentType"
  | "sizeBytes"
  | "classification"
>;

export interface ProfileDocument {
  readonly id: string;
  readonly type: ProfileDocumentType;
  /** An engagement document's kind (Agreement, Rider and so on). */
  readonly kind: string | null;
  /** An engagement document's title, or a certificate of insurance's coverage. */
  readonly title: string | null;
  readonly orgName: string | null;
  readonly projectName: string | null;
  /** A certificate's insurer, or the passport's issuing country (ISO 3166-1 alpha-2). */
  readonly issuer: string | null;
  readonly expiresOn: string | null;
  readonly state: string | null;
  readonly timeZone: string | null;
  readonly file: ProfileDocumentFile | null;
}

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value !== "" ? value : null;
}

const DOCUMENT_TYPES: readonly ProfileDocumentType[] = [
  "Engagement Document",
  "Insurance Certificate",
  "Passport",
];

export function toCertification(row: Row): ProfileCertification | null {
  const name = text(row, "name");
  const source = text(row, "source");
  if (!name || (source !== "Org Record" && source !== "Profile")) return null;
  return {
    id: row.id,
    source,
    name,
    issuingBody: text(row, "issuing_body") ?? "",
    expiresOn: text(row, "expires_on"),
    verified: row["is_verified"] === true,
    verifiedBy: text(row, "verified_by_org_name"),
    timeZone: text(row, "time_zone"),
  };
}

export function toDocument(row: Row): ProfileDocument | null {
  const type = text(row, "document_type");
  if (!type || !(DOCUMENT_TYPES as readonly string[]).includes(type)) return null;
  const versionId = text(row, "file_version_id");
  const objectName = text(row, "file_object_name");
  const classification = text(row, "file_classification");
  // Only Public and Internal files are named, and only those open through a signed URL.
  const file: ProfileDocumentFile | null =
    versionId && objectName && (classification === "Public" || classification === "Internal")
      ? {
          id: versionId,
          versionNumber: Number(row["file_version_number"] ?? 0),
          objectName,
          filename: text(row, "file_name") ?? "",
          contentType: text(row, "file_content_type") ?? "",
          sizeBytes: Number(row["file_size_bytes"] ?? 0),
          classification,
        }
      : null;
  return {
    id: row.id,
    type: type as ProfileDocumentType,
    kind: text(row, "document_kind"),
    title: text(row, "title"),
    orgName: text(row, "org_name"),
    projectName: text(row, "project_name"),
    issuer: text(row, "issuer"),
    expiresOn: text(row, "expires_on"),
    state: text(row, "document_state"),
    timeZone: text(row, "time_zone"),
    file,
  };
}

/** The signed-URL download of a document's file (@xos/data/attachments downloadUrl) takes a whole version. */
export function fileVersion(file: ProfileDocumentFile): AttachmentVersion {
  return { ...file, scanStatus: "Clean", uploadedBy: null, uploadedAt: null };
}

/** Soonest expiry first, then by name; items that never expire last. */
export function byExpiry<T>(
  items: readonly T[],
  expiresOn: (item: T) => string | null,
  name: (item: T) => string,
): T[] {
  return [...items].sort(
    (a, b) =>
      (expiresOn(a) ?? "9999-12-31").localeCompare(expiresOn(b) ?? "9999-12-31") ||
      name(a).localeCompare(name(b)),
  );
}

// The expiring-soon callout -------------------------------------------------------------------------------------------------

export interface Expiring {
  readonly id: string;
  readonly title: string;
  readonly daysLeft: number;
  readonly threshold: ExpiryThreshold;
}

export interface ExpiryCallout {
  /** The most urgent threshold any item has reached: the callout's stage. */
  readonly threshold: ExpiryThreshold;
  readonly tone: "info" | "warning" | "danger";
  /** Every item within the first threshold, soonest first. */
  readonly items: readonly Expiring[];
}

const TONES: Readonly<Record<ExpiryThreshold, ExpiryCallout["tone"]>> = {
  30: "info",
  7: "warning",
  1: "danger",
};

/**
 * What expires within the reminder thresholds, each item counted on its own calendar; null when nothing does. Expired
 * items are left to their rows: the job stops reminding once a date has passed.
 */
export function expiryCallout(
  items: readonly {
    readonly id: string;
    readonly title: string;
    readonly expiresOn: string | null;
    readonly timeZone: string | null;
  }[],
  personZone: string,
  now: Date = new Date(),
): ExpiryCallout | null {
  const expiring = items
    .flatMap((item): Expiring[] => {
      const standing = expiryStanding(item.expiresOn, todayFor(item.timeZone, personZone, now));
      return standing.kind === "expiring"
        ? [
            {
              id: item.id,
              title: item.title,
              daysLeft: standing.daysLeft,
              threshold: standing.threshold,
            },
          ]
        : [];
    })
    .sort((a, b) => a.daysLeft - b.daysLeft || a.title.localeCompare(b.title));
  const first = expiring[0];
  if (!first) return null;
  return { threshold: first.threshold, tone: TONES[first.threshold], items: expiring };
}
