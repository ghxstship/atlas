"use server";

import type { DataError, Result } from "@xos/data";
import { getCurrencyExponent } from "@xos/data/crew";
import {
  AGREEMENT_KINDS,
  approveRequisition,
  createAgreement,
  createCertification,
  createRequisition,
  createRoleAssignment,
  getAgreement,
  recordCertificationHolder,
  rejectRequisition,
  removeCertificationHolder,
  sendAgreement,
  signAgreement,
  transitionAgreement,
  transitionRequisition,
  transitionRoleAssignment,
  updateAgreement,
  updateRequisition,
  type AgreementState,
  type RequisitionState,
  type RoleAssignmentState,
} from "@xos/data/people";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import type { CrewActionState } from "@/lib/crew/action-state";
import { gatewayUrl } from "@/lib/gateway-url";
import { errorMessage } from "@/lib/crew/errors";
import { toMinor } from "@/lib/crew/money";
import { getOrgContext } from "@/lib/shell/context";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import * as enums from "@xos/data/enums";

/**
 * People server actions. Each resolves the viewer's org context (404 when it is gone), validates the
 * form and calls the People repository; the guards and RPCs of migration 0361 decide every write, and
 * refusals come back as sentences in the viewer's language.
 */

export interface PeopleActionState extends CrewActionState {
  /** A signing token and access code, shown once after an agreement is sent (invariant 8). */
  readonly signing?: { readonly link: string; readonly accessCode: string };
}

type State = PeopleActionState;

async function context(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return { ctx, db: ctx.viewer.db, t: await getTranslate() };
}

function done(slug: string, result: Result<unknown>, t: Translate): State {
  if (!result.ok) return { error: errorMessage(t, result.error) };
  revalidatePath(`/${slug}/people`, "layout");
  return { ok: true };
}

const failed = (t: Translate, error: DataError): State => ({ error: errorMessage(t, error) });
const uuid = z.uuid();
const reason = z.string().trim().min(1).max(500);
const isoDate = z.iso.date();
const optionalDate = z.union([isoDate, z.literal("")]);
const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
};
const nullable = (v: string) => (v === "" ? null : v);

function invalid(t: Translate, fields: Record<string, string>): State {
  return {
    error: t("crew.errors.fixFields"),
    fieldErrors: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, t(v)])),
  };
}

// Role assignments ----------------------------------------------------------------------------------------

export async function createAssignmentAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({
      projectId: uuid,
      roleCode: z.string().regex(/^\d{4}\.\d{2}\.\d{2}$/),
      personId: uuid,
      staffingBasis: z.enum(enums.staffingBasis),
      startsOn: optionalDate,
      endsOn: optionalDate,
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success)
    return invalid(t, { projectId: "crew.errors.project", personId: "crew.errors.person" });
  const p = parsed.data;
  return done(
    ctx.org.slug,
    await createRoleAssignment(db, {
      orgId: ctx.org.id,
      projectId: p.projectId,
      roleCode: p.roleCode,
      personId: p.personId,
      staffingBasis: p.staffingBasis,
      requisitionId: nullable(text(form, "requisitionId")),
      startsOn: nullable(p.startsOn),
      endsOn: nullable(p.endsOn),
    }),
    t,
  );
}

const ASSIGNMENT_STATE = z.enum(enums.roleAssignmentState);

export async function transitionAssignmentAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ id: uuid, expected: ASSIGNMENT_STATE, next: ASSIGNMENT_STATE, reason })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { reason: "crew.errors.reason" });
  const p = parsed.data;
  return done(
    ctx.org.slug,
    await transitionRoleAssignment(
      db,
      p.id,
      p.expected as RoleAssignmentState,
      p.next as RoleAssignmentState,
      p.reason,
    ),
    t,
  );
}

// Requisitions ----------------------------------------------------------------------------------------------

async function requisitionInput(
  form: FormData,
  t: Translate,
  db: Awaited<ReturnType<typeof context>>["db"],
) {
  const parsed = z
    .object({
      roleCode: z.string().regex(/^\d{4}\.\d{2}\.\d{2}$/),
      headcount: z.coerce.number().int().min(1).max(10_000),
      currencyCode: z.string().regex(/^[A-Z]{3}$/),
      startsOn: optionalDate,
      endsOn: optionalDate,
      justification: z.string().trim().min(1).max(2000),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) {
    return {
      ok: false as const,
      state: invalid(t, {
        roleCode: "crew.errors.role",
        justification: "people.errors.justification",
      }),
    };
  }
  const p = parsed.data;
  if (p.startsOn && p.endsOn && p.endsOn < p.startsOn) {
    return { ok: false as const, state: invalid(t, { endsOn: "crew.errors.endAfterStart" }) };
  }
  const combo = text(form, "rateCard");
  const [classification, payBasis, arrangement] =
    combo === "" ? [null, null, null] : combo.split("|");
  const unitsRaw = text(form, "unitsPerHead").trim();
  const units = unitsRaw === "" ? null : Number(unitsRaw);
  if (units !== null && (!Number.isFinite(units) || units <= 0)) {
    return { ok: false as const, state: invalid(t, { unitsPerHead: "people.errors.units" }) };
  }
  const exponent = await getCurrencyExponent(db, p.currencyCode);
  const rate = toMinor(text(form, "rate"), exponent.ok ? exponent.data : 2);
  if (rate === undefined)
    return { ok: false as const, state: invalid(t, { rate: "crew.errors.money" }) };
  const roleType = text(form, "roleType");
  return {
    ok: true as const,
    input: {
      roleCode: p.roleCode,
      roleType: roleType === "" ? null : (roleType as never),
      workerClassification: classification ?? null,
      payBasis: payBasis ?? null,
      arrangement: arrangement ?? null,
      headcount: p.headcount,
      unitsPerHead: units,
      rateMinor: rate,
      currencyCode: p.currencyCode,
      startsOn: nullable(p.startsOn),
      endsOn: nullable(p.endsOn),
      justification: p.justification,
    },
  };
}

export async function createRequisitionAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const project = uuid.safeParse(form.get("projectId"));
  if (!project.success) return invalid(t, { projectId: "crew.errors.project" });
  const parsed = await requisitionInput(form, t, db);
  if (!parsed.ok) return parsed.state;
  const result = await createRequisition(db, {
    orgId: ctx.org.id,
    projectId: project.data,
    ...parsed.input,
  });
  if (!result.ok) return failed(t, result.error);
  revalidatePath(`/${ctx.org.slug}/people`, "layout");
  return { ok: true, redirect: `/${ctx.org.slug}/people/requisitions?peek=${result.data.id}` };
}

export async function updateRequisitionAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return failed(t, { kind: "not-found" });
  const parsed = await requisitionInput(form, t, db);
  if (!parsed.ok) return parsed.state;
  return done(ctx.org.slug, await updateRequisition(db, id.data, parsed.input), t);
}

export async function approveRequisitionAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z.object({ id: uuid, reason }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { reason: "crew.errors.reason" });
  const result = await approveRequisition(db, parsed.data.id, parsed.data.reason);
  if (!result.ok) return failed(t, result.error);
  revalidatePath(`/${ctx.org.slug}/people`, "layout");
  return result.data.complete
    ? { ok: true }
    : { ok: true, error: t("people.requisitions.secondApprover") };
}

export async function rejectRequisitionAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z.object({ id: uuid, reason }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { reason: "crew.errors.reason" });
  return done(ctx.org.slug, await rejectRequisition(db, parsed.data.id, parsed.data.reason), t);
}

const REQ_STATE = z.enum(enums.requisitionState);

export async function transitionRequisitionAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ id: uuid, expected: REQ_STATE, next: REQ_STATE, reason })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { reason: "crew.errors.reason" });
  const p = parsed.data;
  return done(
    ctx.org.slug,
    await transitionRequisition(
      db,
      p.id,
      p.expected as RequisitionState,
      p.next as RequisitionState,
      p.reason,
    ),
    t,
  );
}

// Agreements --------------------------------------------------------------------------------------------------

export async function createAgreementAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({
      kind: z.enum(AGREEMENT_KINDS as unknown as [string, ...string[]]),
      title: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(200_000),
      personId: uuid,
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) {
    return invalid(t, {
      title: "crew.errors.name",
      body: "people.errors.body",
      personId: "crew.errors.person",
    });
  }
  const p = parsed.data;
  const result = await createAgreement(db, {
    orgId: ctx.org.id,
    projectId: nullable(text(form, "projectId")),
    personId: p.personId,
    counterpartyId: null,
    offerId: nullable(text(form, "offerId")),
    kind: p.kind as (typeof AGREEMENT_KINDS)[number],
    title: p.title,
    body: p.body,
  });
  if (!result.ok) return failed(t, result.error);
  revalidatePath(`/${ctx.org.slug}/people`, "layout");
  return { ok: true, redirect: `/${ctx.org.slug}/people/agreements?peek=${result.data.id}` };
}

export async function updateAgreementAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({
      id: uuid,
      title: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(200_000),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { title: "crew.errors.name", body: "people.errors.body" });
  return done(ctx.org.slug, await updateAgreement(db, parsed.data.id, parsed.data), t);
}

/** Sends for signature and returns the signing link and access code once (shown, never stored). */
export async function sendAgreementAction(_: State, form: FormData): Promise<State> {
  const { db, t } = await context(form);
  const parsed = z
    .object({ id: uuid, reason, days: z.coerce.number().int().min(1).max(90).default(14) })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { reason: "crew.errors.reason" });
  const result = await sendAgreement(db, parsed.data.id, parsed.data.reason, parsed.data.days);
  if (!result.ok) return failed(t, result.error);
  // No revalidation here: the dialog keeps the one-time link and code on screen and refreshes the
  // page when it closes.
  return {
    ok: true,
    signing: {
      link: gatewayUrl(`/sign/${result.data.signingToken}`),
      accessCode: result.data.accessCode,
    },
  };
}

const AGREEMENT_STATE = z.enum(enums.agreementState);

export async function transitionAgreementAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ id: uuid, expected: AGREEMENT_STATE, next: AGREEMENT_STATE, reason })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { reason: "crew.errors.reason" });
  const p = parsed.data;
  return done(
    ctx.org.slug,
    await transitionAgreement(
      db,
      p.id,
      p.expected as AgreementState,
      p.next as AgreementState,
      p.reason,
    ),
    t,
  );
}

/** Signs as the signed-in person the agreement names, over the exact text shown. */
export async function signAgreementAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ id: uuid, signedName: z.string().trim().min(1).max(200) })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { signedName: "people.errors.signedName" });
  const agreement = await getAgreement(db, parsed.data.id);
  if (!agreement.ok) return failed(t, agreement.error);
  const result = await signAgreement(
    db,
    parsed.data.id,
    parsed.data.signedName,
    agreement.data.body,
  );
  if (!result.ok) return failed(t, result.error);
  if (!result.data.signed) return { error: t("people.agreements.notSigned") };
  revalidatePath(`/${ctx.org.slug}/people`, "layout");
  return { ok: true };
}

// Certifications ------------------------------------------------------------------------------------------------

export async function createCertificationAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(200),
      issuingBody: z.string().trim().min(1).max(200),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success)
    return invalid(t, { name: "crew.errors.name", issuingBody: "crew.errors.name" });
  return done(ctx.org.slug, await createCertification(db, ctx.org.id, parsed.data), t);
}

export async function recordHolderAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ certificationId: uuid, personId: uuid, issuedOn: isoDate, expiresOn: optionalDate })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success)
    return invalid(t, { personId: "crew.errors.person", issuedOn: "crew.errors.date" });
  const p = parsed.data;
  if (p.expiresOn && p.expiresOn < p.issuedOn)
    return invalid(t, { expiresOn: "crew.errors.endAfterStart" });
  return done(
    ctx.org.slug,
    await recordCertificationHolder(db, {
      orgId: ctx.org.id,
      certificationId: p.certificationId,
      personId: p.personId,
      issuedOn: p.issuedOn,
      expiresOn: nullable(p.expiresOn),
    }),
    t,
  );
}

export async function removeHolderAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return failed(t, { kind: "not-found" });
  const result = await removeCertificationHolder(db, id.data);
  if (!result.ok) return failed(t, result.error);
  revalidatePath(`/${ctx.org.slug}/people`, "layout");
  return { ok: true, redirect: `/${ctx.org.slug}/people/certifications` };
}
