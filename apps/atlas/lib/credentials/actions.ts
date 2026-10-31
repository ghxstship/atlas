"use server";

import {
  addCategoryRequirement,
  archiveCredentialCategory,
  createCredentialCategory,
  credentialIssueCheck,
  grantZoneAccess,
  insideNow,
  issueCredential,
  listAccessGrid,
  operationsProjectByKey,
  overrideScan,
  recordScan,
  refusalReasonKey,
  removeCategoryRequirement,
  revokeCredential,
  updateCredentialCategory,
  updateCredentialWindow,
  updateZoneAccess,
  withdrawZoneAccess,
  CATEGORY_CODE,
  type InsideZone,
  type IssueCheck,
} from "@xos/data/credentials";
import {
  countOutcomes,
  credentialPhotoStates,
  removeCredentialPhoto,
  removeCredentialPhotoObjects,
  requestCredentialPhotos,
} from "@xos/data/credential-photos";
import { resolveProjectPerson } from "@xos/data/project-people";
import { resolveScanIntake } from "@xos/data/scan-intake";
import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { failed, type ActionState } from "@/lib/operations/state";
import { localToInstant } from "@/lib/operations/time";
import { getTranslate } from "@/lib/shell/translate";
import { formatAsked, outcomeSummary } from "./photo-outcomes";

/**
 * Credentials actions (Section 4.2). Each resolves the viewer's org context again (404 when it is
 * gone), validates its input and calls the repository; row level security and the guards of
 * migrations 0352 and 0470 decide every write, and their refusals come back as catalog keys.
 */

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

function done(slug: string, result?: Record<string, string>): ActionState {
  revalidatePath(`/${slug}`, "layout");
  return result ? { ok: true, result } : { ok: true };
}

const TimeZone = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
});

const Category = z.object({
  code: z
    .string()
    .trim()
    .transform((c) => c.toUpperCase())
    .pipe(z.string().regex(CATEGORY_CODE)),
  name: z.string().trim().min(1).max(100),
  // R7: a parking pass is a category of kind Parking.
  kind: z.enum(["Access", "Parking"]).optional(),
});

export async function createCategoryAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = Category.extend({ projectId: z.uuid() }).safeParse({
    projectId: form.get("projectId"),
    code: form.get("code"),
    name: form.get("name"),
    kind: form.get("kind") ?? undefined,
  });
  if (!parsed.success) return { error: "categoryInput" };
  const result = await createCredentialCategory(ctx.viewer.db, {
    orgId: ctx.org.id,
    ...parsed.data,
  });
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug, { code: parsed.data.code });
}

export async function updateCategoryAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = Category.extend({ id: z.uuid() }).safeParse({
    id: form.get("id"),
    code: form.get("code"),
    name: form.get("name"),
    kind: form.get("kind") ?? undefined,
  });
  if (!parsed.success) return { error: "categoryInput" };
  const result = await updateCredentialCategory(ctx.viewer.db, parsed.data.id, parsed.data);
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

export async function archiveCategoryAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "notFound" };
  const result = await archiveCredentialCategory(ctx.viewer.db, id.data);
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

const Window = z
  .object({
    timeZone: TimeZone,
    validFrom: z.string().optional(),
    validTo: z.string().optional(),
  })
  .transform((w, check) => {
    const from = w.validFrom ? localToInstant(w.validFrom, w.timeZone) : null;
    const to = w.validTo ? localToInstant(w.validTo, w.timeZone) : null;
    if ((w.validFrom && !from) || (w.validTo && !to) || (from && to && to <= from)) {
      check.addIssue({ code: "custom", message: "window" });
      return z.NEVER;
    }
    return { validFrom: from, validTo: to };
  });

function windowInput(form: FormData) {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  return { timeZone: form.get("timeZone"), validFrom: text("validFrom"), validTo: text("validTo") };
}

export async function issueCredentialAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const ids = z
    .object({ projectId: z.uuid(), categoryId: z.uuid(), holderPersonId: z.uuid() })
    .safeParse({
      projectId: form.get("projectId"),
      categoryId: form.get("categoryId"),
      holderPersonId: form.get("holderPersonId"),
    });
  if (!ids.success) return { error: "issueInput" };
  const window = Window.safeParse(windowInput(form));
  if (!window.success) return { error: "window" };
  // An engaged non-member's badge is issued under their engagement; a member's never is.
  const person = await resolveProjectPerson(
    ctx.viewer.db,
    ids.data.projectId,
    ids.data.holderPersonId,
  );
  if (!person.ok) return failed(person.error);
  const result = await issueCredential(ctx.viewer.db, {
    orgId: ctx.org.id,
    ...ids.data,
    ...(person.data.membershipId === null && person.data.engagementId
      ? { engagementId: person.data.engagementId }
      : {}),
    ...(window.data.validFrom ? { validFrom: window.data.validFrom } : {}),
    validTo: window.data.validTo,
  });
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug, { number: result.data.number });
}

export async function updateWindowAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "notFound" };
  const window = Window.safeParse(windowInput(form));
  if (!window.success || !window.data.validFrom) return { error: "window" };
  const result = await updateCredentialWindow(ctx.viewer.db, id.data, {
    validFrom: window.data.validFrom,
    validTo: window.data.validTo,
  });
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

export async function revokeCredentialAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "notFound" };
  if (form.get("confirm") !== "on") return { error: "confirmRevoke" };
  const result = await revokeCredential(ctx.viewer.db, id.data);
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

// Access grid ------------------------------------------------------------------------------------

const GridWindow = z
  .object({ timeZone: TimeZone, windowStartsAt: z.string(), windowEndsAt: z.string() })
  .transform((w, check) => {
    const starts = localToInstant(w.windowStartsAt, w.timeZone);
    const ends = localToInstant(w.windowEndsAt, w.timeZone);
    if (!starts || !ends || ends <= starts) {
      check.addIssue({ code: "custom", message: "window" });
      return z.NEVER;
    }
    return { windowStartsAt: starts, windowEndsAt: ends };
  });

function gridWindowInput(form: FormData) {
  return {
    timeZone: form.get("timeZone"),
    windowStartsAt: form.get("windowStartsAt"),
    windowEndsAt: form.get("windowEndsAt"),
  };
}

export async function grantZoneAccessAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const ids = z
    .object({
      projectId: z.uuid(),
      categoryId: z.uuid(),
      zoneId: z.uuid(),
      accessLevelId: z.string().min(1).max(40),
    })
    .safeParse({
      projectId: form.get("projectId"),
      categoryId: form.get("categoryId"),
      zoneId: form.get("zoneId"),
      accessLevelId: form.get("accessLevelId"),
    });
  if (!ids.success) return { error: "gridInput" };
  const window = GridWindow.safeParse(gridWindowInput(form));
  if (!window.success) return { error: "window" };
  const result = await grantZoneAccess(ctx.viewer.db, {
    orgId: ctx.org.id,
    ...ids.data,
    ...window.data,
  });
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

export async function updateZoneAccessAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ id: z.uuid(), accessLevelId: z.string().min(1).max(40) })
    .safeParse({ id: form.get("id"), accessLevelId: form.get("accessLevelId") });
  if (!parsed.success) return { error: "gridInput" };
  const window = GridWindow.safeParse(gridWindowInput(form));
  if (!window.success) return { error: "window" };
  const result = await updateZoneAccess(ctx.viewer.db, parsed.data.id, {
    accessLevelId: parsed.data.accessLevelId,
    ...window.data,
  });
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

export async function withdrawZoneAccessAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "notFound" };
  const result = await withdrawZoneAccess(ctx.viewer.db, id.data);
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

/**
 * Toggles one cell of the access matrix. Granting adds a row at the given level and window;
 * withdrawing removes every row of the category and zone, so the cell reads empty afterwards.
 */
export async function setMatrixCellAction(input: {
  org: string;
  projectId: string;
  categoryId: string;
  zoneId: string;
  granted: boolean;
  accessLevelId: string;
  windowStartsAt: string;
  windowEndsAt: string;
}): Promise<ActionState> {
  const ctx = await getOrgContext(input.org);
  if (!ctx) notFound();
  const ids = z
    .object({ projectId: z.uuid(), categoryId: z.uuid(), zoneId: z.uuid() })
    .safeParse(input);
  if (!ids.success) return { error: "gridInput" };
  if (input.granted) {
    const result = await grantZoneAccess(ctx.viewer.db, {
      orgId: ctx.org.id,
      projectId: input.projectId,
      categoryId: input.categoryId,
      zoneId: input.zoneId,
      accessLevelId: input.accessLevelId,
      windowStartsAt: input.windowStartsAt,
      windowEndsAt: input.windowEndsAt,
    });
    if (!result.ok) return failed(result.error);
    return done(ctx.org.slug);
  }
  const grid = await listAccessGrid(ctx.viewer.db, ctx.org.id, input.projectId);
  if (!grid.ok) return failed(grid.error);
  for (const row of grid.data.filter(
    (g) => g.categoryId === input.categoryId && g.zoneId === input.zoneId,
  )) {
    const result = await withdrawZoneAccess(ctx.viewer.db, row.id);
    if (!result.ok) return failed(result.error);
  }
  return done(ctx.org.slug);
}

// Scans ------------------------------------------------------------------------------------------

/**
 * Dismisses an unknown scanned code from the intake queue with a note (0367): needs
 * credentials.scan.write on the scan's project, and a scan is resolved once (A95).
 */
export async function dismissScanIntakeAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ scanId: z.uuid(), note: z.string().trim().min(1).max(1000) })
    .safeParse({ scanId: form.get("scanId"), note: form.get("note") });
  if (!parsed.success) return { error: "dismissInput" };
  const result = await resolveScanIntake(ctx.viewer.db, parsed.data.scanId, {
    resolution: "Dismissed",
    note: parsed.data.note,
  });
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

export async function recordScanAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      zoneId: z.uuid(),
      credentialNumber: z.string().trim().min(1).max(40),
      direction: z.enum(["In", "Out"]).default("In"),
    })
    .safeParse({
      zoneId: form.get("zoneId"),
      credentialNumber: form.get("credentialNumber"),
      direction: form.get("direction") ?? undefined,
    });
  if (!parsed.success) return { error: "scanInput" };
  const result = await recordScan(ctx.viewer.db, parsed.data);
  if (!result.ok) return failed(result.error);
  revalidatePath(`/${ctx.org.slug}`, "layout");
  const t = await getTranslate();
  // An Out scan is never refused (2970); a denial names the database's reason in the viewer's language.
  const reason = result.data.refusalReason;
  return {
    ok: true,
    result: {
      number: result.data.credentialNumber,
      holder: result.data.holderName ?? "none",
      zone: result.data.zoneCode,
      decision: parsed.data.direction === "Out" ? "Out" : result.data.result,
      reason: reason ? t(`credentials.scans.reasons.${refusalReasonKey(reason)}`) : "none",
    },
  };
}

/**
 * A supervisor lets in someone the gate denied (app.override_access_scan, 2970): a new Granted In row tied to the
 * denied scan, with the reason. The database checks the capability, the holder and the 15 minutes.
 */
export async function overrideScanAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ scanId: z.uuid(), reason: z.string().trim().min(1).max(300) })
    .safeParse({ scanId: form.get("scanId"), reason: form.get("reason") });
  if (!parsed.success) return { error: "rules.scan_override_reason" };
  const result = await overrideScan(ctx.viewer.db, parsed.data);
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug, {
    number: result.data.credentialNumber,
    zone: result.data.zoneCode,
  });
}

/** The scan log's Inside now section, read again every 30 seconds while it is not paused. */
export async function loadInsideNow(
  org: string,
  projectKey: string,
): Promise<{ readonly zones: readonly InsideZone[]; readonly at: string } | null> {
  const ctx = await getOrgContext(org);
  if (!ctx) return null;
  const project = await operationsProjectByKey(ctx.viewer.db, ctx.org.id, projectKey);
  if (!project.ok) return null;
  const zones = await insideNow(ctx.viewer.db, {
    orgId: ctx.org.id,
    projectId: project.data.id,
    venueId: project.data.venueId,
  });
  return zones.ok ? { zones: zones.data, at: new Date().toISOString() } : null;
}

// Badge photos (P5) --------------------------------------------------------------------------------

/** Asks one credential's holder for a badge photo, from the credential record. */
export async function requestCredentialPhotosAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "notFound" };
  const result = await requestCredentialPhotos(ctx.viewer.db, [id.data]);
  if (!result.ok) return failed(result.error);
  revalidatePath(`/${ctx.org.slug}`, "layout");
  const t = await getTranslate();
  return { ok: true, result: { summary: outcomeSummary(t, countOutcomes(result.data)) } };
}

/**
 * The print panel's "Request missing photos": asks the holders of the checked badges whose photo is Missing or
 * Requested, then returns to the panel with a count per outcome (counts only, never a name, in the URL).
 */
export async function requestMissingPhotosAction(form: FormData): Promise<void> {
  const ctx = await contextFor(form);
  const ids = z.array(z.uuid()).min(1).max(100).safeParse(form.getAll("id"));
  const back = z
    .string()
    .regex(/^\/[^/]/)
    .safeParse(form.get("back"));
  const target = new URL(
    back.success ? back.data : `/${ctx.org.slug}/credentials/issued`,
    "http://x",
  );
  target.searchParams.set("print", "1");
  if (ids.success) {
    const states = await credentialPhotoStates(ctx.viewer.db, ids.data);
    const wanted = ids.data.filter((id) => {
      const state = states.ok ? states.data.get(id) : undefined;
      return state === "Missing" || state === "Requested";
    });
    const result = wanted.length > 0 ? await requestCredentialPhotos(ctx.viewer.db, wanted) : null;
    const counts = result?.ok ? countOutcomes(result.data) : {};
    target.searchParams.set("asked", formatAsked(counts));
    revalidatePath(`/${ctx.org.slug}`, "layout");
  }
  redirect(`${target.pathname}${target.search}` as Route);
}

/**
 * An issuer removes the holder's badge photo, then deletes the objects the database hands back (none when the scanner
 * already deleted it). A photo still being scanned, or one the scan could not clear, is refused by rule and stays.
 */
export async function removeCredentialPhotoAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const person = z.uuid().safeParse(form.get("personId"));
  if (!person.success) return { error: "notFound" };
  if (form.get("confirm") !== "on") return { error: "confirmRemovePhoto" };
  const removed = await removeCredentialPhoto(ctx.viewer.db, ctx.org.id, person.data);
  if (!removed.ok) return failed(removed.error);
  const gone = await removeCredentialPhotoObjects(ctx.viewer.db, removed.data);
  if (!gone.ok) return failed(gone.error);
  return done(ctx.org.slug);
}

// Required before issue and the issue checks (B8, 2972 and 2973) ---------------------------------------------------

/** Adds a course (course:<id>) or a certification (certification:<id>) a category requires before issue. */
export async function addRequirementAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const categoryId = z.uuid().safeParse(form.get("categoryId"));
  const raw = String(form.get("requirement") ?? "");
  const [kind, id] = raw.split(":");
  if (
    !categoryId.success ||
    !z.uuid().safeParse(id).success ||
    (kind !== "course" && kind !== "certification")
  ) {
    return { error: "requirementInput" };
  }
  const result = await addCategoryRequirement(ctx.viewer.db, {
    categoryId: categoryId.data,
    ...(kind === "course" ? { trainingCourseId: id as string } : { certificationId: id as string }),
  });
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

export async function removeRequirementAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "notFound" };
  const result = await removeCategoryRequirement(ctx.viewer.db, id.data);
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

/**
 * What the issue form shows before Issue (app.credential_issue_check): read again whenever the category, the holder or
 * the window changes. The window is typed in the project's time zone. Nothing is shown until both are chosen.
 */
export async function loadIssueChecks(input: {
  readonly org: string;
  readonly timeZone: string;
  readonly categoryId: string;
  readonly holderPersonId: string;
  readonly validFrom: string;
  readonly validTo: string;
}): Promise<readonly IssueCheck[]> {
  const ctx = await getOrgContext(input.org);
  if (!ctx) return [];
  if (
    !z.uuid().safeParse(input.categoryId).success ||
    !z.uuid().safeParse(input.holderPersonId).success
  ) {
    return [];
  }
  const zone = TimeZone.safeParse(input.timeZone);
  if (!zone.success) return [];
  const result = await credentialIssueCheck(ctx.viewer.db, {
    categoryId: input.categoryId,
    holderPersonId: input.holderPersonId,
    validFrom: localToInstant(input.validFrom, zone.data),
    validTo: localToInstant(input.validTo, zone.data),
  });
  return result.ok ? result.data : [];
}
