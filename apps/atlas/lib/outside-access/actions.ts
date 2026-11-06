"use server";

import {
  regenerateLiveLink,
  revokeLiveLink,
  listLiveLinks,
  liveLinkPath,
  type LiveLink,
} from "@xos/data/live-links";
import {
  addPackItem,
  addPackRecipient,
  clearPackSchedule,
  createStakeholderPack,
  getPackSchedule,
  listPackActivity,
  listPackFileChoices,
  listPackItems,
  listPackRecipients,
  listPackSuppliers,
  listPackSignatures,
  listStakeholderPacks,
  orderPackItems,
  removePackItem,
  resetPackRecipientCode,
  revokePackRecipient,
  revokeStakeholderPack,
  sendStakeholderPack,
  setPackSchedule,
  updateStakeholderPack,
  type PackCadence,
  type PackItem,
  type PackRecipient,
  type PackRecipientActivity,
  type PackSchedule,
  type PackSignature,
  type PackSummary,
} from "@xos/data/stakeholder-packs";
import {
  createIntakeLink,
  decideIntakeRequest,
  intakeOnFile,
  intakePath,
  intakeRequestParty,
  listIntakeRequests,
  regenerateIntakeLink,
  revokeIntakeLink,
  type IntakeOnFile,
  type IntakeRequest,
  type IntakeRequestParty,
  type NewIntakeLink,
} from "@xos/data/vendor-intake";
import {
  createFormLink,
  formLinkPath,
  regenerateFormLink,
  revokeFormLink,
} from "@xos/data/form-links";
import { fail, ok, toDataError } from "@xos/data/result";
import { revokeShareLink } from "@xos/data/share-links";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { env } from "@/lib/env";
import { gatewayUrl } from "@/lib/gateway-url";
import { getProjectContextFor } from "@/lib/projects/context";
import { getOrgContext } from "@/lib/shell/context";
import { dayInZone, endOfDayInZone } from "@/lib/stakeholder-packs/expiry";

/**
 * The Outside access section's writes (B2, ADR 0141): each runs as the signed-in person, and the database applies
 * every rule. The actions only report its refusals by rule. A new link, code and QR value come back once and live in
 * the section's client state above the list, never in a row a refresh would replace.
 */

export type OutsideResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string };

function refused(error: { kind: string; rule?: string }): { ok: false; error: string } {
  if (error.kind === "refusal" && error.rule) return { ok: false, error: error.rule };
  return { ok: false, error: error.kind === "not-found" ? "notFound" : "unexpected" };
}

/** One-time values to show: a link or a code, or both. */
export interface Revealed {
  readonly heading: string;
  readonly url: string | null;
  readonly accessCode: string | null;
  readonly name: string | null;
  readonly expiresAt: string | null;
}

export interface ProjectKeyRef {
  readonly org: string;
  readonly projectKey: string;
}

const id = z.uuid();

async function project(ref: ProjectKeyRef) {
  const ctx = await getProjectContextFor({ org: ref.org, projectKey: ref.projectKey });
  return ctx;
}

function touch(ref: ProjectKeyRef) {
  revalidatePath(`/${ref.org}/p/${ref.projectKey}/settings`);
}

function atlasUrl(path: string): string {
  return new URL(path, env().ATLAS_SITE_URL).toString();
}

// Revoking and regenerating from a row -------------------------------------------------------------------

export type RevokeKind = "live" | "file" | "advance" | "signing" | "recipient" | "intake" | "form";

export async function revokeSourceAction(
  ref: ProjectKeyRef,
  kind: RevokeKind,
  sourceId: string,
): Promise<OutsideResult<null>> {
  const ctx = await project(ref);
  const parsed = id.safeParse(sourceId);
  if (!ctx || !parsed.success) return { ok: false, error: "notFound" };
  const db = ctx.org.viewer.db;
  const done = await (async () => {
    switch (kind) {
      case "live":
        return revokeLiveLink(db, parsed.data);
      case "file":
        return revokeShareLink(db, parsed.data);
      case "recipient":
        return revokePackRecipient(db, parsed.data);
      case "intake":
        return revokeIntakeLink(db, parsed.data);
      case "form":
        return revokeFormLink(db, parsed.data);
      case "advance":
      case "signing": {
        const rpc =
          kind === "advance" ? "revoke_advance_token" : "revoke_engagement_document_token";
        const { error } = await db.rpc(rpc, { p_token_id: parsed.data });
        return error ? fail(toDataError(error)) : ok("");
      }
    }
  })();
  if (!done.ok) return refused(done.error);
  touch(ref);
  return { ok: true, data: null };
}

export async function regenerateSourceAction(
  ref: ProjectKeyRef,
  kind: "view" | "display" | "intake" | "form",
  sourceId: string,
  name: string,
): Promise<OutsideResult<Revealed>> {
  const ctx = await project(ref);
  const parsed = id.safeParse(sourceId);
  if (!ctx || !parsed.success) return { ok: false, error: "notFound" };
  const db = ctx.org.viewer.db;
  if (kind === "intake") {
    const r = await regenerateIntakeLink(db, parsed.data);
    if (!r.ok) return refused(r.error);
    touch(ref);
    return {
      ok: true,
      data: {
        heading: "regenerated",
        url: gatewayUrl(intakePath(r.data.token)),
        accessCode: r.data.accessCode,
        name,
        expiresAt: r.data.expiresAt,
      },
    };
  }
  if (kind === "form") {
    const r = await regenerateFormLink(db, parsed.data);
    if (!r.ok) return refused(r.error);
    touch(ref);
    return {
      ok: true,
      data: {
        heading: "regenerated",
        url: gatewayUrl(formLinkPath(r.data.token)),
        accessCode: r.data.accessCode,
        name,
        expiresAt: r.data.expiresAt,
      },
    };
  }
  const r = await regenerateLiveLink(db, parsed.data);
  if (!r.ok) return refused(r.error);
  touch(ref);
  return {
    ok: true,
    data: {
      heading: "regenerated",
      url: atlasUrl(liveLinkPath(kind === "view" ? "View" : "Display", r.data.token)),
      accessCode: r.data.accessCode,
      name,
      expiresAt: r.data.expiresAt,
    },
  };
}

export async function resetRecipientCodeAction(
  ref: ProjectKeyRef,
  recipientId: string,
  name: string,
): Promise<OutsideResult<Revealed>> {
  const ctx = await project(ref);
  const parsed = id.safeParse(recipientId);
  if (!ctx || !parsed.success) return { ok: false, error: "notFound" };
  const r = await resetPackRecipientCode(ctx.org.viewer.db, parsed.data);
  if (!r.ok) return refused(r.error);
  touch(ref);
  return {
    ok: true,
    data: { heading: "code", url: null, accessCode: r.data, name, expiresAt: null },
  };
}

// The pack editor ------------------------------------------------------------------------------------------

export interface PackEditorData {
  readonly pack: PackSummary;
  readonly items: readonly PackItem[];
  readonly recipients: readonly PackRecipient[];
  readonly activity: readonly PackRecipientActivity[];
  readonly signatures: readonly PackSignature[];
  readonly schedule: PackSchedule | null;
}

export async function listPacksAction(
  ref: ProjectKeyRef,
): Promise<OutsideResult<readonly PackSummary[]>> {
  const ctx = await project(ref);
  if (!ctx) return { ok: false, error: "notFound" };
  const r = await listStakeholderPacks(ctx.org.viewer.db, ctx.project.id);
  return r.ok ? { ok: true, data: r.data } : refused(r.error);
}

export async function loadPackAction(
  ref: ProjectKeyRef,
  packId: string,
): Promise<OutsideResult<PackEditorData>> {
  const ctx = await project(ref);
  const parsed = id.safeParse(packId);
  if (!ctx || !parsed.success) return { ok: false, error: "notFound" };
  const db = ctx.org.viewer.db;
  const [packs, items, recipients, activity, signatures, schedule] = await Promise.all([
    listStakeholderPacks(db, ctx.project.id),
    listPackItems(db, parsed.data),
    listPackRecipients(db, parsed.data),
    listPackActivity(db, parsed.data),
    listPackSignatures(db, parsed.data),
    getPackSchedule(db, parsed.data),
  ]);
  if (!packs.ok) return refused(packs.error);
  if (!items.ok) return refused(items.error);
  if (!recipients.ok) return refused(recipients.error);
  if (!activity.ok) return refused(activity.error);
  if (!signatures.ok) return refused(signatures.error);
  if (!schedule.ok) return refused(schedule.error);
  const pack = packs.data.find((p) => p.id === parsed.data);
  if (!pack) return { ok: false, error: "notFound" };
  return {
    ok: true,
    data: {
      pack,
      items: items.data,
      recipients: recipients.data,
      activity: activity.data,
      signatures: signatures.data,
      schedule: schedule.data,
    },
  };
}

const packDetails = z.object({
  name: z.string().trim().min(1).max(120),
  message: z.string().trim().max(2000),
  note: z.string().trim().max(200),
  expiresOn: z.iso.date(),
});

export async function savePackAction(
  ref: ProjectKeyRef,
  packId: string | null,
  input: { name: string; message: string; note: string; expiresOn: string },
): Promise<OutsideResult<string>> {
  const ctx = await project(ref);
  const parsed = packDetails.safeParse(input);
  if (!ctx) return { ok: false, error: "notFound" };
  if (!parsed.success) return { ok: false, error: "invalid" };
  const details = {
    name: parsed.data.name,
    message: parsed.data.message === "" ? null : parsed.data.message,
    note: parsed.data.note === "" ? null : parsed.data.note,
    expiresAt: endOfDayInZone(parsed.data.expiresOn, ctx.project.timeZone),
  };
  const db = ctx.org.viewer.db;
  const saved =
    packId === null
      ? await createStakeholderPack(db, { projectId: ctx.project.id, ...details })
      : await updateStakeholderPack(db, { id: packId, ...details });
  if (!saved.ok) return refused(saved.error);
  touch(ref);
  return { ok: true, data: packId ?? String(saved.data) };
}

export async function revokePackAction(
  ref: ProjectKeyRef,
  packId: string,
): Promise<OutsideResult<null>> {
  const ctx = await project(ref);
  if (!ctx) return { ok: false, error: "notFound" };
  const r = await revokeStakeholderPack(ctx.org.viewer.db, packId);
  if (!r.ok) return refused(r.error);
  touch(ref);
  return { ok: true, data: null };
}

export interface PackItemChoice {
  readonly id: string;
  readonly title: string;
}

/** What the Items step offers: the project's live links, and its Public or Internal files. */
export async function packItemChoicesAction(ref: ProjectKeyRef): Promise<
  OutsideResult<{
    readonly links: readonly (LiveLink & { readonly title: string })[];
    readonly files: readonly PackItemChoice[];
  }>
> {
  const ctx = await project(ref);
  if (!ctx) return { ok: false, error: "notFound" };
  const db = ctx.org.viewer.db;
  const links = await listLiveLinks(db, { projectId: ctx.project.id });
  if (!links.ok) return refused(links.error);
  const files = await listPackFileChoices(db, ctx.org.org.id, ctx.project.id);
  if (!files.ok) return refused(files.error);
  return {
    ok: true,
    data: {
      links: links.data
        .filter((l) => l.state === "Active" || l.state === "Locked")
        .map((l) => ({ ...l, title: l.note ?? `${l.kind} ${l.tokenHint}` })),
      files: files.data,
    },
  };
}

/** Suppliers a recipient can be filed under: the org's counterparties. */
export async function packSupplierChoicesAction(
  ref: ProjectKeyRef,
): Promise<OutsideResult<readonly { readonly id: string; readonly name: string }[]>> {
  const ctx = await project(ref);
  if (!ctx) return { ok: false, error: "notFound" };
  const r = await listPackSuppliers(ctx.org.viewer.db, ctx.org.org.id);
  return r.ok ? { ok: true, data: r.data } : refused(r.error);
}

export async function addPackItemAction(
  ref: ProjectKeyRef,
  packId: string,
  input: { subject: string; title: string; acknowledge: boolean },
): Promise<OutsideResult<null>> {
  const ctx = await project(ref);
  if (!ctx) return { ok: false, error: "notFound" };
  const [kind, subjectId] = input.subject.split(":");
  const parsed = id.safeParse(subjectId);
  if (!parsed.success || (kind !== "link" && kind !== "file")) {
    return { ok: false, error: "invalid" };
  }
  const r = await addPackItem(ctx.org.viewer.db, {
    packId,
    subject: kind === "link" ? { liveLinkId: parsed.data } : { attachmentId: parsed.data },
    title: input.title.trim(),
    requiresAcknowledgement: input.acknowledge,
  });
  if (!r.ok) return refused(r.error);
  touch(ref);
  return { ok: true, data: null };
}

export async function removePackItemAction(
  ref: ProjectKeyRef,
  itemId: string,
): Promise<OutsideResult<null>> {
  const ctx = await project(ref);
  if (!ctx) return { ok: false, error: "notFound" };
  const r = await removePackItem(ctx.org.viewer.db, itemId);
  if (!r.ok) return refused(r.error);
  touch(ref);
  return { ok: true, data: null };
}

export async function orderPackItemsAction(
  ref: ProjectKeyRef,
  packId: string,
  itemIds: readonly string[],
): Promise<OutsideResult<null>> {
  const ctx = await project(ref);
  if (!ctx) return { ok: false, error: "notFound" };
  const r = await orderPackItems(ctx.org.viewer.db, packId, itemIds);
  return r.ok ? { ok: true, data: null } : refused(r.error);
}

export async function addRecipientAction(
  ref: ProjectKeyRef,
  packId: string,
  input: { fullName: string; email: string; counterpartyId: string; label: string },
): Promise<OutsideResult<Revealed>> {
  const ctx = await project(ref);
  if (!ctx) return { ok: false, error: "notFound" };
  const supplier = input.counterpartyId === "" ? null : id.safeParse(input.counterpartyId);
  if (supplier && !supplier.success) return { ok: false, error: "invalid" };
  const r = await addPackRecipient(ctx.org.viewer.db, {
    packId,
    fullName: input.fullName.trim(),
    email: input.email,
    counterpartyId: supplier ? (supplier.data ?? null) : null,
    label: input.label.trim() === "" ? null : input.label.trim(),
  });
  if (!r.ok) return refused(r.error);
  touch(ref);
  return {
    ok: true,
    data: {
      heading: "code",
      url: null,
      accessCode: r.data.accessCode,
      name: input.fullName.trim(),
      expiresAt: null,
    },
  };
}

export async function sendPackAction(
  ref: ProjectKeyRef,
  packId: string,
  recipientIds: readonly string[] | null,
): Promise<OutsideResult<number>> {
  const ctx = await project(ref);
  if (!ctx) return { ok: false, error: "notFound" };
  const r = await sendStakeholderPack(ctx.org.viewer.db, packId, recipientIds);
  if (!r.ok) return refused(r.error);
  touch(ref);
  return { ok: true, data: r.data };
}

export async function savePackScheduleAction(
  ref: ProjectKeyRef,
  packId: string,
  input: { cadence: string; localHour: number; weekday: number | null; monthDay: number | null },
): Promise<OutsideResult<null>> {
  const ctx = await project(ref);
  if (!ctx) return { ok: false, error: "notFound" };
  const db = ctx.org.viewer.db;
  if (input.cadence === "Off") {
    const r = await clearPackSchedule(db, packId);
    return r.ok ? { ok: true, data: null } : refused(r.error);
  }
  const r = await setPackSchedule(db, {
    packId,
    cadence: input.cadence as PackCadence,
    localHour: input.localHour,
    weekday: input.cadence === "Weekly" ? input.weekday : null,
    monthDay: input.cadence === "Monthly" ? input.monthDay : null,
    timeZone: ctx.project.timeZone,
  });
  return r.ok ? { ok: true, data: null } : refused(r.error);
}

// Intake links -------------------------------------------------------------------------------------------------

export interface IntakeOptions {
  readonly rateCard: readonly {
    readonly roleCode: string;
    readonly roleLabel: string;
    readonly classification: string;
    readonly payBasis: string | null;
    readonly arrangement: string | null;
  }[];
  readonly counterpartyTypes: readonly string[];
  readonly documents: readonly { readonly id: string; readonly title: string }[];
  readonly today: string;
  readonly lastDay: string;
}

export async function intakeOptionsAction(
  ref: ProjectKeyRef,
): Promise<OutsideResult<IntakeOptions>> {
  const ctx = await project(ref);
  if (!ctx) return { ok: false, error: "notFound" };
  const db = ctx.org.viewer.db;
  const xpms = (db as unknown as { schema(name: string): typeof db }).schema("xpms");
  const [rates, classes, types, documents] = await Promise.all([
    (
      xpms as never as {
        from(t: string): { select(c: string): Promise<{ data: unknown; error: unknown }> };
      }
    )
      .from("rate_card")
      .select("role_code, worker_classification, pay_basis, arrangement, role:role(job_title)"),
    (
      xpms as never as {
        from(t: string): { select(c: string): Promise<{ data: unknown; error: unknown }> };
      }
    )
      .from("worker_classification")
      .select("code, is_employee"),
    (
      xpms as never as {
        from(t: string): { select(c: string): Promise<{ data: unknown; error: unknown }> };
      }
    )
      .from("dim_counterparty_type")
      .select("counterparty_type"),
    db
      .from("documents")
      .select("id, title, project_id")
      .or(`project_id.is.null,project_id.eq.${ctx.project.id}`)
      .is("deleted_at", null)
      .order("title")
      .limit(200),
  ]);
  if (rates.error || classes.error || types.error || documents.error) {
    return { ok: false, error: "unexpected" };
  }
  const employee = new Set(
    ((classes.data ?? []) as { code: string; is_employee: boolean }[])
      .filter((c) => c.is_employee)
      .map((c) => c.code),
  );
  return {
    ok: true,
    data: {
      rateCard: (
        (rates.data ?? []) as {
          role_code: string;
          worker_classification: string;
          pay_basis: string | null;
          arrangement: string | null;
          role: { job_title: string } | null;
        }[]
      )
        .filter((r) => !employee.has(r.worker_classification))
        .map((r) => ({
          roleCode: r.role_code,
          roleLabel: r.role?.job_title ?? r.role_code,
          classification: r.worker_classification,
          payBasis: r.pay_basis,
          arrangement: r.arrangement,
        })),
      counterpartyTypes: ((types.data ?? []) as { counterparty_type: string }[]).map(
        (t) => t.counterparty_type,
      ),
      documents: ((documents.data ?? []) as unknown as { id: string; title: string }[]).map(
        (d) => ({
          id: d.id,
          title: d.title,
        }),
      ),
      today: dayInZone(0, ctx.project.timeZone),
      lastDay: dayInZone(90, ctx.project.timeZone),
    },
  };
}

export async function createIntakeLinkAction(
  ref: ProjectKeyRef,
  input: Omit<NewIntakeLink, "projectId" | "expiresAt"> & { readonly expiresOn: string },
): Promise<OutsideResult<Revealed>> {
  const ctx = await project(ref);
  if (!ctx) return { ok: false, error: "notFound" };
  const { expiresOn, ...rest } = input;
  const r = await createIntakeLink(ctx.org.viewer.db, {
    ...rest,
    projectId: ctx.project.id,
    expiresAt: endOfDayInZone(expiresOn, ctx.project.timeZone),
  });
  if (!r.ok) return refused(r.error);
  touch(ref);
  return {
    ok: true,
    data: {
      heading: "intake",
      url: gatewayUrl(intakePath(r.data.token)),
      accessCode: r.data.accessCode,
      name: input.title,
      expiresAt: r.data.expiresAt,
    },
  };
}

// Intake requests (the Engagements tab) -----------------------------------------------------------------------

export interface IntakeRequestRow {
  readonly request: IntakeRequest;
  readonly party: IntakeRequestParty | null;
  readonly onFile: IntakeOnFile;
}

export async function listIntakeRequestsAction(
  ref: ProjectKeyRef,
): Promise<OutsideResult<readonly IntakeRequestRow[]>> {
  const ctx = await project(ref);
  if (!ctx) return { ok: false, error: "notFound" };
  const db = ctx.org.viewer.db;
  const requests = await listIntakeRequests(db, ctx.project.id);
  if (!requests.ok) return refused(requests.error);
  const rows = await Promise.all(
    requests.data.map(async (request) => {
      const [party, onFile] = await Promise.all([
        intakeRequestParty(db, request.id),
        intakeOnFile(db, request),
      ]);
      return {
        request,
        party: party.ok ? party.data : null,
        onFile: onFile.ok
          ? onFile.data
          : { taxFormKind: null, tinLast4: null, payoutProvider: null, payoutLast4: null },
      };
    }),
  );
  return { ok: true, data: rows };
}

export async function decideIntakeRequestAction(
  ref: ProjectKeyRef,
  requestId: string,
  approve: boolean,
  reason: string,
): Promise<OutsideResult<null>> {
  const ctx = await project(ref);
  if (!ctx) return { ok: false, error: "notFound" };
  const r = await decideIntakeRequest(ctx.org.viewer.db, {
    id: requestId,
    approve,
    reason: reason.trim() === "" ? null : reason.trim(),
  });
  if (!r.ok) return refused(r.error);
  revalidatePath(`/${ref.org}/p/${ref.projectKey}/engagements`);
  touch(ref);
  return { ok: true, data: null };
}

// Public form links (Knowledge, Forms) --------------------------------------------------------------------------

export async function formLinkOptionsAction(org: string): Promise<
  OutsideResult<{
    readonly projects: readonly { value: string; label: string }[];
    readonly today: string;
    readonly lastDay: string;
  }>
> {
  const ctx = await getOrgContext(org);
  if (!ctx) return { ok: false, error: "notFound" };
  const { data, error } = await ctx.viewer.db
    .from("projects")
    .select("id, name")
    .eq("org_id", ctx.org.id)
    .is("deleted_at", null)
    .order("name")
    .limit(200);
  if (error) return { ok: false, error: "unexpected" };
  return {
    ok: true,
    data: {
      projects: ((data ?? []) as unknown as { id: string; name: string }[]).map((p) => ({
        value: p.id,
        label: p.name,
      })),
      today: dayInZone(0, "UTC"),
      lastDay: dayInZone(89, "UTC"),
    },
  };
}

export async function createFormLinkAction(
  org: string,
  input: {
    templateId: string;
    projectId: string | null;
    expiresOn: string;
    dailyCap: number;
    onePerEmail: boolean;
  },
): Promise<OutsideResult<Revealed>> {
  const ctx = await getOrgContext(org);
  if (!ctx) return { ok: false, error: "notFound" };
  // A form link's expiry is the end of the day in the named project's zone; with none, the end of the UTC day.
  let zone = "UTC";
  if (input.projectId) {
    const { data } = await ctx.viewer.db
      .from("projects")
      .select("time_zone")
      .eq("id", input.projectId)
      .maybeSingle();
    zone = (data as { time_zone?: string } | null)?.time_zone ?? zone;
  }
  const r = await createFormLink(ctx.viewer.db, {
    templateId: input.templateId,
    expiresAt: endOfDayInZone(input.expiresOn, zone),
    projectId: input.projectId,
    dailyCap: input.dailyCap,
    maxResponses: null,
    onePerEmail: input.onePerEmail,
    note: null,
  });
  if (!r.ok) return refused(r.error);
  revalidatePath(`/${org}/knowledge/forms`);
  return {
    ok: true,
    data: {
      heading: "form",
      url: gatewayUrl(formLinkPath(r.data.token)),
      accessCode: r.data.accessCode,
      name: null,
      expiresAt: r.data.expiresAt,
    },
  };
}
