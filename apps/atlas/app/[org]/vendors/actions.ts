"use server";

import { revealSharedSupplierDiversityNumber } from "@xos/data/supplier-diversity";
import {
  addVendorBankAccount,
  createInsuranceCertificate,
  createScorecard,
  createSponsorAsset,
  createSponsorEntitlement,
  createVendor,
  createVendorClass,
  decidePrequalification,
  deleteInsuranceCertificate,
  deleteScorecard,
  deleteSponsorEntitlement,
  deleteVendorClass,
  recordEntitlementDelivery,
  requestPrequalification,
  setEntitlementFulfilled,
  setVendorClasses,
  transitionSponsorAsset,
  transitionVendor,
  updateInsuranceCertificate,
  updateScorecard,
  updateSponsorEntitlement,
  updateVendor,
  updateVendorClass,
  SPONSOR_ASSET_KINDS,
  VENDOR_STATES,
  type InsuranceCertificateInput,
  type ReviewState,
  type SponsorAssetKind,
  type ScorecardInput,
  type VendorState,
} from "@xos/data/vendors";
import { actionContext, finish } from "@/lib/collection-kit/actions";
import {
  all,
  decimal,
  fromDataError,
  FieldErrors,
  integer,
  isoDate,
  moneyToMinor,
  requiredText,
  text,
  uuid,
  type ActionState,
} from "@/lib/collection-kit/forms";
import * as enums from "@xos/data/enums";

/**
 * Vendor actions (Section 4.2 Vendors). Row level security and the 0330 RPCs decide every write:
 * vendors.vendor.write for vendors and prequalification requests, vendors.class.write for classes,
 * vendors.coi.write, vendors.scorecard.write, vendors.entitlement.write and
 * vendors.bank_details.write; prequalification decisions need vendors.prequalification.approve and
 * a person other than the requester.
 */

const MODULE = "vendors";
const CURRENCY = /^[A-Z]{3}$/;

function currency(form: FormData, name: string, errors: FieldErrors): string | null {
  const value = text(form, name)?.toUpperCase() ?? null;
  if (value !== null && !CURRENCY.test(value)) errors.add(name, "currency");
  return value;
}

// Vendors --------------------------------------------------------------------------------------------

export async function createVendorAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const counterpartyId = uuid(form, "counterpartyId");
  const name = requiredText(form, "name", 200);
  if (counterpartyId === null && name === null) errors.add("name", "required");
  const terms = integer(form, "paymentTermsDays", 0, 365);
  if (terms === undefined) errors.add("paymentTermsDays", "wholeNumber");
  const code = currency(form, "defaultCurrencyCode", errors);
  if (errors.any) return errors.state;
  const result = await createVendor(ctx.viewer.db, {
    orgId: ctx.org.id,
    counterpartyId,
    name,
    counterpartyType: text(form, "counterpartyType"),
    paymentTermsDays: terms ?? null,
    defaultCurrencyCode: code,
  });
  return finish(result, ctx, MODULE);
}

export async function updateVendorAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const errors = new FieldErrors();
  const terms = integer(form, "paymentTermsDays", 0, 365);
  if (terms === undefined) errors.add("paymentTermsDays", "wholeNumber");
  const code = currency(form, "defaultCurrencyCode", errors);
  if (id === null) return { error: "notFound" };
  if (errors.any) return errors.state;
  const updated = await updateVendor(ctx.viewer.db, id, {
    paymentTermsDays: terms ?? null,
    defaultCurrencyCode: code,
  });
  if (!updated.ok) return finish(updated, ctx, MODULE);
  if (form.get("classesShown") === "1") {
    return finish(await setVendorClasses(ctx.viewer.db, id, all(form, "classIds")), ctx, MODULE);
  }
  return finish(updated, ctx, MODULE);
}

export async function transitionVendorAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const expected = text(form, "expected") as VendorState | null;
  const next = text(form, "next") as VendorState | null;
  const reason = requiredText(form, "reason", 500);
  if (reason === null) return { fieldErrors: { reason: "required" } };
  if (
    !id ||
    !expected ||
    !next ||
    !VENDOR_STATES.includes(expected) ||
    !VENDOR_STATES.includes(next)
  ) {
    return { error: "invalid" };
  }
  return finish(await transitionVendor(ctx.viewer.db, { id, expected, next, reason }), ctx, MODULE);
}

export async function addBankAccountAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const vendorId = uuid(form, "vendorId");
  const bankName = errors.need("bankName", requiredText(form, "bankName", 200));
  const accountHolder = errors.need("accountHolder", requiredText(form, "accountHolder", 200));
  const accountNumber = errors.need("accountNumber", requiredText(form, "accountNumber", 64));
  const routingNumber = text(form, "routingNumber");
  // The database keeps the letters and digits (2010): 4 to 34 for the account, up to 34 for routing.
  const digits = (value: string) => value.replace(/[^0-9A-Za-z]/g, "").length;
  if (accountNumber !== null && (digits(accountNumber) < 4 || digits(accountNumber) > 34)) {
    errors.add("accountNumber", "accountNumber");
  }
  if (routingNumber !== null && (routingNumber.length > 64 || digits(routingNumber) > 34)) {
    errors.add("routingNumber", "routingNumber");
  }
  if (vendorId === null) return { error: "notFound" };
  if (errors.any || !bankName || !accountHolder || !accountNumber) return errors.state;
  const result = await addVendorBankAccount(ctx.viewer.db, {
    vendorId,
    bankName,
    accountHolder,
    accountNumber,
    routingNumber,
  });
  return finish(result, ctx, MODULE);
}

// Classes --------------------------------------------------------------------------------------------

function classInput(form: FormData, errors: FieldErrors) {
  const name = errors.need("name", requiredText(form, "name", 100));
  return {
    name: name ?? "",
    description: text(form, "description"),
    stdVendorClassId: text(form, "stdVendorClassId"),
  };
}

export async function createVendorClassAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const input = classInput(form, errors);
  if (errors.any) return errors.state;
  return finish(await createVendorClass(ctx.viewer.db, ctx.org.id, input), ctx, MODULE);
}

export async function updateVendorClassAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const errors = new FieldErrors();
  const input = classInput(form, errors);
  if (id === null) return { error: "notFound" };
  if (errors.any) return errors.state;
  return finish(await updateVendorClass(ctx.viewer.db, id, input), ctx, MODULE);
}

export async function deleteVendorClassAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await deleteVendorClass(ctx.viewer.db, id), ctx, MODULE);
}

// Prequalification -------------------------------------------------------------------------------------

export async function requestPrequalificationAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const vendorId = errors.need("vendorId", uuid(form, "vendorId"));
  const scopeNote = errors.need("scopeNote", requiredText(form, "scopeNote", 1000));
  if (errors.any || !vendorId || !scopeNote) return errors.state;
  return finish(await requestPrequalification(ctx.viewer.db, { vendorId, scopeNote }), ctx, MODULE);
}

export async function decidePrequalificationAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const decision = text(form, "decision");
  const validTo = isoDate(form, "validTo");
  if (validTo === undefined) return { fieldErrors: { validTo: "date" } };
  if (id === null || (decision !== "Approved" && decision !== "Rejected"))
    return { error: "invalid" };
  return finish(
    await decidePrequalification(ctx.viewer.db, { id, decision, validTo: validTo ?? null }),
    ctx,
    MODULE,
  );
}

// Insurance certificates ----------------------------------------------------------------------------------

function certificateInput(form: FormData, errors: FieldErrors): InsuranceCertificateInput | null {
  const vendorId = errors.need("vendorId", uuid(form, "vendorId"));
  const insurer = errors.need("insurer", requiredText(form, "insurer", 200));
  const policyIdentifier = errors.need(
    "policyIdentifier",
    requiredText(form, "policyIdentifier", 100),
  );
  const coverageType = errors.need("coverageType", requiredText(form, "coverageType", 100));
  const validFrom = isoDate(form, "validFrom");
  const validTo = isoDate(form, "validTo");
  errors.need("validFrom", validFrom, validFrom === undefined ? "date" : "required");
  errors.need("validTo", validTo, validTo === undefined ? "date" : "required");
  if (validFrom && validTo && validTo < validFrom) errors.add("validTo", "dateOrder");
  const code = currency(form, "currencyCode", errors);
  const limit = moneyToMinor(text(form, "coverageLimit"));
  if (limit === undefined) errors.add("coverageLimit", "money");
  if (limit !== null && limit !== undefined && code === null)
    errors.add("currencyCode", "currencyNeeded");
  if (
    errors.any ||
    !vendorId ||
    !insurer ||
    !policyIdentifier ||
    !coverageType ||
    !validFrom ||
    !validTo
  ) {
    return null;
  }
  return {
    vendorId,
    insurer,
    policyIdentifier,
    coverageType,
    coverageLimitMinor: limit ?? null,
    currencyCode: code,
    validFrom,
    validTo,
    documentUri: text(form, "documentUri"),
  };
}

export async function createCertificateAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const input = certificateInput(form, errors);
  if (!input) return errors.state;
  return finish(await createInsuranceCertificate(ctx.viewer.db, input), ctx, MODULE);
}

export async function updateCertificateAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const errors = new FieldErrors();
  const input = certificateInput(form, errors);
  if (id === null) return { error: "notFound" };
  if (!input) return errors.state;
  return finish(await updateInsuranceCertificate(ctx.viewer.db, id, input), ctx, MODULE);
}

export async function deleteCertificateAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await deleteInsuranceCertificate(ctx.viewer.db, id), ctx, MODULE);
}

// Scorecards ----------------------------------------------------------------------------------------------

function scorecardInput(form: FormData, errors: FieldErrors): ScorecardInput | null {
  const vendorId = errors.need("vendorId", uuid(form, "vendorId"));
  const periodEnd = isoDate(form, "periodEnd");
  errors.need("periodEnd", periodEnd, periodEnd === undefined ? "date" : "required");
  const score = (name: string) => {
    const value = integer(form, name, 1, 5);
    if (value === undefined) errors.add(name, "score");
    return value ?? null;
  };
  const input = {
    qualityScore: score("qualityScore"),
    deliveryScore: score("deliveryScore"),
    safetyScore: score("safetyScore"),
  };
  if (errors.any || !vendorId || !periodEnd) return null;
  return {
    vendorId,
    projectId: uuid(form, "projectId"),
    periodEnd,
    ...input,
    note: text(form, "note"),
  };
}

export async function createScorecardAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const input = scorecardInput(form, errors);
  if (!input) return errors.state;
  return finish(await createScorecard(ctx.viewer.db, input), ctx, MODULE);
}

export async function updateScorecardAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const errors = new FieldErrors();
  const input = scorecardInput(form, errors);
  if (id === null) return { error: "notFound" };
  if (!input) return errors.state;
  return finish(await updateScorecard(ctx.viewer.db, id, input), ctx, MODULE);
}

export async function deleteScorecardAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await deleteScorecard(ctx.viewer.db, id), ctx, MODULE);
}

// Sponsor entitlements --------------------------------------------------------------------------------------

function entitlementInput(form: FormData, errors: FieldErrors) {
  const counterpartyId = errors.need("counterpartyId", uuid(form, "counterpartyId"));
  const description = errors.need("description", requiredText(form, "description", 500));
  const quantity = integer(form, "quantity", 0);
  if (quantity === undefined) errors.add("quantity", "wholeNumber");
  const dueOn = isoDate(form, "dueOn");
  if (dueOn === undefined) errors.add("dueOn", "date");
  return { counterpartyId, description, quantity: quantity ?? null, dueOn: dueOn ?? null };
}

export async function createEntitlementAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const projectId = errors.need("projectId", uuid(form, "projectId"));
  const input = entitlementInput(form, errors);
  if (errors.any || !projectId || !input.counterpartyId || !input.description) return errors.state;
  return finish(
    await createSponsorEntitlement(ctx.viewer.db, {
      ...input,
      projectId,
      counterpartyId: input.counterpartyId,
      description: input.description,
    }),
    ctx,
    MODULE,
  );
}

export async function updateEntitlementAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const errors = new FieldErrors();
  const input = entitlementInput(form, errors);
  if (id === null) return { error: "notFound" };
  if (errors.any || !input.counterpartyId || !input.description) return errors.state;
  return finish(
    await updateSponsorEntitlement(ctx.viewer.db, id, {
      ...input,
      counterpartyId: input.counterpartyId,
      description: input.description,
    }),
    ctx,
    MODULE,
  );
}

export async function fulfillEntitlementAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(
    await setEntitlementFulfilled(ctx.viewer.db, id, form.get("fulfilled") === "1"),
    ctx,
    MODULE,
  );
}

export async function deleteEntitlementAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await deleteSponsorEntitlement(ctx.viewer.db, id), ctx, MODULE);
}

// Sponsor assets and deliveries (0492) ------------------------------------------------------------------------

const REVIEW_STATES: readonly ReviewState[] = enums.reviewState;

export async function createSponsorAssetAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const entitlementId = uuid(form, "entitlementId");
  const kind = text(form, "kind") as SponsorAssetKind | null;
  if (!kind || !SPONSOR_ASSET_KINDS.includes(kind)) errors.add("kind", "required");
  const title = errors.need("title", requiredText(form, "title", 200));
  const dueOn = isoDate(form, "dueOn");
  if (dueOn === undefined) errors.add("dueOn", "date");
  if (entitlementId === null) return { error: "notFound" };
  if (errors.any || !kind || !title) return errors.state;
  return finish(
    await createSponsorAsset(ctx.viewer.db, {
      entitlementId,
      kind,
      title,
      usageNote: text(form, "usageNote"),
      dueOn: dueOn ?? null,
    }),
    ctx,
    MODULE,
  );
}

export async function transitionSponsorAssetAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const expected = text(form, "expected") as ReviewState | null;
  const next = text(form, "next") as ReviewState | null;
  const reason = requiredText(form, "reason", 500);
  if (reason === null) return { fieldErrors: { reason: "required" } };
  if (
    !id ||
    !expected ||
    !next ||
    !REVIEW_STATES.includes(expected) ||
    !REVIEW_STATES.includes(next)
  ) {
    return { error: "invalid" };
  }
  return finish(
    await transitionSponsorAsset(ctx.viewer.db, { id, expected, next, reason }),
    ctx,
    MODULE,
  );
}

export async function recordDeliveryAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const entitlementId = uuid(form, "entitlementId");
  const deliveredOn = isoDate(form, "deliveredOn");
  errors.need("deliveredOn", deliveredOn, deliveredOn === undefined ? "date" : "required");
  const quantity = decimal(form, "quantityDelivered");
  if (quantity === undefined || (quantity !== null && quantity < 0))
    errors.add("quantityDelivered", "number");
  if (entitlementId === null) return { error: "notFound" };
  if (errors.any || !deliveredOn) return errors.state;
  return finish(
    await recordEntitlementDelivery(ctx.viewer.db, {
      entitlementId,
      deliveredOn,
      quantityDelivered: quantity ?? null,
      note: text(form, "note"),
    }),
    ctx,
    MODULE,
  );
}

// Supplier diversity (2011) ---------------------------------------------------------------------------------------

/** What the reveal form gets back: the number once, never stored, or why it was refused. */
export interface RevealState extends ActionState {
  readonly revealed?: string;
}

/**
 * The audited reveal of a certificate number shared with the org (decision 38). The database asks for
 * data.restricted.read.government_id and step-up; a `step_up_required` refusal opens the step-up dialog.
 */
export async function revealSupplierDiversityNumberAction(
  _: RevealState,
  form: FormData,
): Promise<RevealState> {
  const ctx = await actionContext(form);
  const shareId = uuid(form, "shareId");
  const reason = text(form, "reason") ?? "";
  if (shareId === null) return { error: "notFound" };
  if (reason.length < 10 || reason.length > 500) return { rule: "certificate_reveal_reason" };
  const result = await revealSharedSupplierDiversityNumber(ctx.viewer.db, shareId, reason);
  return result.ok ? { revealed: result.data } : fromDataError(result.error);
}
