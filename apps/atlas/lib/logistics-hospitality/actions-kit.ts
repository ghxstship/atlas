import type { DataError, Result } from "@xos/data";
import {
  listOperationsProjects,
  localToInstant,
  type OperationsProject,
} from "@xos/data/logistics";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";

/**
 * Shared plumbing for the Logistics and Hospitality server actions (A11). Each action resolves the
 * viewer's org context again (404 when it is gone), validates its input with Zod and calls the
 * repository; row level security and the 0351, 0440 and 0970 triggers decide every write. Refusals
 * come back as catalog keys under `logistics.common.errors`.
 */

export interface ActionState {
  /** Catalog key under logistics.common.errors. */
  readonly error?: string;
  /** Field name to catalog key under logistics.common.fieldErrors. */
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly ok?: boolean;
  /** Display key of the row the action created or changed. */
  readonly key?: string;
}

export const INITIAL_STATE: ActionState = {};

/** Database rules whose refusal has its own sentence in the catalog. */
const KNOWN_RULES = new Set([
  "dock_slot_overlap",
  "dock_slot_checked_in",
  "dock_slot_canceled",
  "enumeration_domain",
  "fulfillment_closed",
  "fulfillment_state_conflict",
  "fulfillment_transition_not_allowed",
  "transition_reason_required",
  "sod_approval_requester",
  "accommodation_block_full",
  "accommodation_block_excludes_stays",
  "accommodation_block_deleted",
  "accommodation_assignment_outside_block",
  "accommodation_assignment_duplicate",
]);

export function errorKey(error: DataError): string {
  switch (error.kind) {
    case "refusal":
      return KNOWN_RULES.has(error.rule) ? error.rule : "refused";
    case "not-found":
      return "notFound";
    case "conflict":
      return "conflict";
    case "invalid":
      return "invalid";
    default:
      return "unexpected";
  }
}

export function failed(result: Result<unknown> & { ok: false }): ActionState {
  return { error: errorKey(result.error) };
}

/** The org context named by the form's `org` field, or 404. */
export async function contextFor(form: FormData): Promise<OrgContext> {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

/** The org context for actions called with arguments instead of a form. */
export async function contextForSlug(slug: string): Promise<OrgContext> {
  const ctx = await getOrgContext(slug);
  if (!ctx) notFound();
  return ctx;
}

/** One project of the org the viewer can read, for its time zone; null when it is not readable. */
export async function projectFor(ctx: OrgContext, projectId: string): Promise<OperationsProject | null> {
  const projects = await listOperationsProjects(ctx.viewer.db, ctx.org.id);
  if (!projects.ok) return null;
  return projects.data.find((p) => p.id === projectId) ?? null;
}

/** Refreshes every org page, so lists, peeks and project tabs show the change. */
export function refresh(ctx: OrgContext): void {
  revalidatePath(`/${ctx.org.slug}`, "layout");
}

export const uuid = z.uuid();
export const optionalUuid = z
  .string()
  .transform((v) => (v === "" ? null : v))
  .pipe(z.uuid().nullable());
export const requiredText = (max: number) => z.string().trim().min(1).max(max);
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v));

/** A form field's string value; missing fields read as the empty string. */
export function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * A datetime-local field read in the project's zone: null when blank, undefined when it is not a
 * valid local date and time.
 */
export function zonedInstant(
  form: FormData,
  name: string,
  timeZone: string,
): string | null | undefined {
  const raw = field(form, name).trim();
  if (raw === "") return null;
  return localToInstant(raw, timeZone) ?? undefined;
}

/**
 * Money typed in major units ("189.00") as integer minor units, null when blank (unpriced, never
 * zero), or undefined when it is not an amount. USD-style exponent 2 covers the currencies offered.
 */
export function minorUnits(raw: string): number | null | undefined {
  const text = raw.trim().replace(/,/g, "");
  if (text === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return undefined;
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** A positive decimal quantity, or undefined when the text is not one. */
export function quantity(raw: string): number | undefined {
  const value = Number(raw.trim());
  return raw.trim() !== "" && Number.isFinite(value) && value > 0 ? value : undefined;
}
