"use server";

import {
  addPoLine,
  approveMatchedInvoice,
  approvePurchaseOrder,
  createCatalogBinding,
  createInvoiceMatch,
  createPoChangeOrder,
  createPurchaseOrder,
  createPurchaseOrderFromResponse,
  createRfq,
  createSubmittal,
  createVendorProduct,
  decidePoChangeOrder,
  deleteCatalogBinding,
  deleteVendorProduct,
  getRfq,
  inviteVendorToRfq,
  listCurrencies,
  listRfqResponses,
  pricePoChangeOrder,
  recordGoodsReceipt,
  recordRfqResponse,
  removePoLine,
  removeRfqInvitation,
  resolveInvoiceMatch,
  transitionPurchaseOrder,
  transitionRfq,
  transitionSubmittal,
  updateCatalogBinding,
  updatePoLine,
  updateRfq,
  updateSubmittal,
  PO_STATES,
  REVIEW_STATES,
  RFQ_STATES,
  SUBMITTAL_KINDS,
  type PoLineInput,
  type PoState,
  type ReviewState,
  type RfqState,
  type SubmittalKind,
} from "@xos/data/procurement";
import type { XosClient } from "@xos/data";
import { applySuggestions, suggestionIds } from "@/lib/aurora/suggestions";
import { actionContext, finish } from "@/lib/collection-kit/actions";
import {
  all,
  decimal,
  FieldErrors,
  integer,
  isoDate,
  isoInstant,
  moneyToMinor,
  requiredText,
  text,
  uuid,
  type ActionState,
} from "@/lib/collection-kit/forms";

/**
 * Procurement actions (Section 4.2 Procurement). Row level security and A03's RPCs decide every
 * write: procurement.rfq.* for RFQs (issuing, unsealing and awarding each have their own
 * capability), procurement.po.* for orders, finance.po.approve under spend authority and never by
 * the creator, procurement.receipt.write, procurement.invoice_match.write and
 * finance.invoice.approve, procurement.catalog.write. Refusals come back with their rule.
 */

const MODULE = "procurement";

async function exponentOf(db: XosClient, currency: string | null): Promise<number> {
  if (currency === null) return 2;
  const list = await listCurrencies(db);
  return (list.ok ? list.data.find((c) => c.code === currency)?.minorUnits : undefined) ?? 2;
}

function reasonOf(form: FormData): string | null {
  return requiredText(form, "reason", 500);
}

function move<S extends string>(form: FormData, states: readonly S[]) {
  const id = uuid(form, "id");
  const expected = text(form, "expected") as S | null;
  const next = text(form, "next") as S | null;
  if (!id || !expected || !next || !states.includes(expected) || !states.includes(next))
    return null;
  return { id, expected, next };
}

// RFQs ------------------------------------------------------------------------------------------------

export async function createRfqAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const projectId = errors.need("projectId", uuid(form, "projectId"));
  const title = errors.need("title", requiredText(form, "title", 200));
  const due = isoInstant(form, "responsesDueAt");
  if (due === undefined) errors.add("responsesDueAt", "date");
  if (errors.any || !projectId || !title) return errors.state;
  return finish(
    await createRfq(ctx.viewer.db, { projectId, title, responsesDueAt: due ?? null }),
    ctx,
    MODULE,
  );
}

export async function updateRfqAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const errors = new FieldErrors();
  const title = errors.need("title", requiredText(form, "title", 200));
  const due = isoInstant(form, "responsesDueAt");
  if (due === undefined) errors.add("responsesDueAt", "date");
  if (id === null) return { error: "notFound" };
  if (errors.any || !title) return errors.state;
  return finish(
    await updateRfq(ctx.viewer.db, id, { title, responsesDueAt: due ?? null }),
    ctx,
    MODULE,
  );
}

export async function transitionRfqAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const reason = reasonOf(form);
  if (reason === null) return { fieldErrors: { reason: "required" } };
  const m = move<RfqState>(form, RFQ_STATES);
  if (!m) return { error: "invalid" };
  return finish(await transitionRfq(ctx.viewer.db, { ...m, reason }), ctx, MODULE);
}

export async function inviteVendorAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const rfqId = uuid(form, "rfqId");
  const vendorId = uuid(form, "vendorId");
  if (rfqId === null) return { error: "notFound" };
  if (vendorId === null) return { fieldErrors: { vendorId: "required" } };
  return finish(await inviteVendorToRfq(ctx.viewer.db, rfqId, vendorId), ctx, MODULE);
}

export async function removeInvitationAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const rfqId = uuid(form, "rfqId");
  const vendorId = uuid(form, "vendorId");
  if (rfqId === null || vendorId === null) return { error: "notFound" };
  return finish(await removeRfqInvitation(ctx.viewer.db, rfqId, vendorId), ctx, MODULE);
}

export async function recordResponseAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const rfqId = uuid(form, "rfqId");
  const vendorId = errors.need("vendorId", uuid(form, "vendorId"));
  const currency = text(form, "currencyCode")?.toUpperCase() ?? null;
  if (currency === null || !/^[A-Z]{3}$/.test(currency)) errors.add("currencyCode", "currency");
  const validUntil = isoDate(form, "validUntil");
  if (validUntil === undefined) errors.add("validUntil", "date");
  const exponent = await exponentOf(ctx.viewer.db, currency);
  const descriptions = form.getAll("lineDescription").map((v) => String(v).trim());
  const quantities = form.getAll("lineQuantity").map((v) => String(v).trim());
  const prices = form.getAll("linePrice").map((v) => String(v));
  const lines = descriptions.flatMap((description, i) => {
    if (description === "") return [];
    const quantity = Number(quantities[i] ?? "");
    if (!Number.isFinite(quantity) || quantity <= 0) {
      errors.add("lines", "quantity");
      return [];
    }
    const price = moneyToMinor(prices[i] ?? "", exponent);
    if (price === undefined) {
      errors.add("lines", "money");
      return [];
    }
    return [{ description, quantity, unitPriceMinor: price }];
  });
  if (lines.length === 0) errors.add("lines", "lines");
  if (rfqId === null) return { error: "notFound" };
  if (errors.any || !vendorId || !currency) return errors.state;
  const recorded = await recordRfqResponse(ctx.viewer.db, {
    rfqId,
    vendorId,
    validUntil: validUntil ?? null,
    currencyCode: currency,
    lines,
  });
  // A form Aurora filled from a quote closes its suggestions with the response written (A95);
  // its quoted lines are stored with the response, so the line suggestions name the response too.
  if (recorded.ok) {
    await applySuggestions(
      ctx.viewer.db,
      suggestionIds(form),
      recorded.data.id,
      "Saved from the RFQ response form after review.",
    );
  }
  return finish(recorded, ctx, MODULE);
}

export async function orderFromResponseAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const rfqId = uuid(form, "rfqId");
  const responseId = uuid(form, "responseId");
  if (rfqId === null || responseId === null) return { error: "notFound" };
  const [rfq, responses] = await Promise.all([
    getRfq(ctx.viewer.db, rfqId),
    listRfqResponses(ctx.viewer.db, rfqId),
  ]);
  if (!rfq.ok) return finish(rfq, ctx, MODULE);
  if (!responses.ok) return finish(responses, ctx, MODULE);
  const response = responses.data.find((r) => r.id === responseId);
  if (!response) return { error: "notFound" };
  return finish(
    await createPurchaseOrderFromResponse(ctx.viewer.db, {
      projectId: rfq.data.projectId,
      response,
    }),
    ctx,
    MODULE,
  );
}

// Purchase orders --------------------------------------------------------------------------------------

export async function createPoAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const projectId = errors.need("projectId", uuid(form, "projectId"));
  const vendorId = errors.need("vendorId", uuid(form, "vendorId"));
  const currency = text(form, "currencyCode")?.toUpperCase() ?? null;
  if (currency === null || !/^[A-Z]{3}$/.test(currency)) errors.add("currencyCode", "currency");
  if (errors.any || !projectId || !vendorId || !currency) return errors.state;
  return finish(
    await createPurchaseOrder(ctx.viewer.db, { projectId, vendorId, currencyCode: currency }),
    ctx,
    MODULE,
  );
}

async function lineInput(
  form: FormData,
  errors: FieldErrors,
  db: XosClient,
): Promise<PoLineInput | null> {
  const description = errors.need("description", requiredText(form, "description", 500));
  const quantity = decimal(form, "quantity");
  if (quantity === null || quantity === undefined || quantity <= 0)
    errors.add("quantity", "quantity");
  const currency = text(form, "currencyCode");
  const price = moneyToMinor(text(form, "unitPrice"), await exponentOf(db, currency));
  if (price === undefined) errors.add("unitPrice", "money");
  if (
    errors.any ||
    !description ||
    quantity === null ||
    quantity === undefined ||
    price === undefined
  ) {
    return null;
  }
  return {
    description,
    quantity,
    unitPriceMinor: price,
    unitBasis: text(form, "unitBasis"),
    elementId: text(form, "elementId"),
    budgetLineId: uuid(form, "budgetLineId"),
  };
}

export async function addPoLineAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "purchaseOrderId");
  const errors = new FieldErrors();
  const input = await lineInput(form, errors, ctx.viewer.db);
  if (id === null) return { error: "notFound" };
  if (!input) return errors.state;
  return finish(await addPoLine(ctx.viewer.db, id, input), ctx, MODULE);
}

export async function updatePoLineAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const errors = new FieldErrors();
  const input = await lineInput(form, errors, ctx.viewer.db);
  if (id === null) return { error: "notFound" };
  if (!input) return errors.state;
  return finish(await updatePoLine(ctx.viewer.db, id, input), ctx, MODULE);
}

export async function removePoLineAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await removePoLine(ctx.viewer.db, id), ctx, MODULE);
}

export async function approvePoAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const reason = reasonOf(form);
  if (reason === null) return { fieldErrors: { reason: "required" } };
  if (id === null) return { error: "notFound" };
  const result = await approvePurchaseOrder(ctx.viewer.db, id, reason);
  if (result.ok && !result.data.approved) {
    finish(result, ctx, MODULE);
    return { error: "approvalPending" };
  }
  return finish(result, ctx, MODULE);
}

export async function transitionPoAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const reason = reasonOf(form);
  if (reason === null) return { fieldErrors: { reason: "required" } };
  const m = move<PoState>(form, PO_STATES);
  if (!m) return { error: "invalid" };
  return finish(await transitionPurchaseOrder(ctx.viewer.db, { ...m, reason }), ctx, MODULE);
}

export async function createChangeOrderAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const purchaseOrderId = uuid(form, "purchaseOrderId");
  const description = errors.need("description", requiredText(form, "description", 500));
  const amount = moneyToMinor(
    text(form, "amountDelta"),
    await exponentOf(ctx.viewer.db, text(form, "currencyCode")),
  );
  if (amount === undefined) errors.add("amountDelta", "money");
  if (purchaseOrderId === null) return { error: "notFound" };
  if (errors.any || !description || amount === undefined) return errors.state;
  return finish(
    await createPoChangeOrder(ctx.viewer.db, {
      purchaseOrderId,
      description,
      amountDeltaMinor: amount,
    }),
    ctx,
    MODULE,
  );
}

export async function priceChangeOrderAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const amount = moneyToMinor(
    text(form, "amountDelta"),
    await exponentOf(ctx.viewer.db, text(form, "currencyCode")),
  );
  if (amount === undefined || amount === null) return { fieldErrors: { amountDelta: "money" } };
  if (id === null) return { error: "notFound" };
  return finish(await pricePoChangeOrder(ctx.viewer.db, id, amount), ctx, MODULE);
}

export async function decideChangeOrderAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const decision = text(form, "decision");
  const reason = reasonOf(form);
  if (reason === null) return { fieldErrors: { reason: "required" } };
  if (id === null || (decision !== "Approved" && decision !== "Rejected"))
    return { error: "invalid" };
  const result = await decidePoChangeOrder(ctx.viewer.db, { id, decision, reason });
  if (result.ok && !result.data.decided) {
    finish(result, ctx, MODULE);
    return { error: "approvalPending" };
  }
  return finish(result, ctx, MODULE);
}

// Receipts and matching ------------------------------------------------------------------------------------

export async function recordReceiptAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const purchaseOrderId = uuid(form, "purchaseOrderId");
  if (purchaseOrderId === null) return { fieldErrors: { purchaseOrderId: "required" } };
  const errors = new FieldErrors();
  const lines = all(form, "lineId").flatMap((lineId) => {
    const raw = text(form, `received-${lineId}`);
    if (raw === null) return [];
    const quantity = Number(raw);
    if (!Number.isFinite(quantity) || quantity < 0) {
      errors.add(`received-${lineId}`, "number");
      return [];
    }
    return quantity > 0 ? [{ poLineId: lineId, quantity }] : [];
  });
  if (lines.length === 0) errors.add("lines", "lines");
  if (errors.any) return errors.state;
  return finish(
    await recordGoodsReceipt(ctx.viewer.db, { purchaseOrderId, note: text(form, "note"), lines }),
    ctx,
    MODULE,
  );
}

export async function createMatchAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const invoiceId = errors.need("invoiceId", uuid(form, "invoiceId"));
  const receipt = text(form, "goodsReceiptId");
  const [purchaseOrderId, goodsReceiptId] = receipt?.split(":") ?? [];
  if (!purchaseOrderId || !goodsReceiptId) errors.add("goodsReceiptId", "required");
  if (errors.any || !invoiceId || !purchaseOrderId || !goodsReceiptId) return errors.state;
  return finish(
    await createInvoiceMatch(ctx.viewer.db, { invoiceId, purchaseOrderId, goodsReceiptId }),
    ctx,
    MODULE,
  );
}

export async function resolveMatchAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const note = requiredText(form, "reason", 1000);
  if (note === null) return { fieldErrors: { reason: "required" } };
  if (id === null) return { error: "notFound" };
  return finish(await resolveInvoiceMatch(ctx.viewer.db, id, note), ctx, MODULE);
}

export async function approveInvoiceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "invoiceId");
  const reason = reasonOf(form);
  if (reason === null) return { fieldErrors: { reason: "required" } };
  if (id === null) return { error: "notFound" };
  const result = await approveMatchedInvoice(ctx.viewer.db, id, reason);
  if (result.ok && !result.data.approved) {
    finish(result, ctx, MODULE);
    return { error: "approvalPending" };
  }
  return finish(result, ctx, MODULE);
}

// Catalog --------------------------------------------------------------------------------------------------

async function bindingInput(form: FormData, errors: FieldErrors, db: XosClient) {
  const name = errors.need("name", requiredText(form, "name", 200));
  const currency = text(form, "currencyCode")?.toUpperCase() ?? null;
  const price = moneyToMinor(text(form, "defaultPrice"), await exponentOf(db, currency));
  if (price === undefined) errors.add("defaultPrice", "money");
  if (price !== null && price !== undefined && currency === null)
    errors.add("currencyCode", "currencyNeeded");
  return {
    name: name ?? "",
    unitBasis: text(form, "unitBasis"),
    defaultUnitPriceMinor: price ?? null,
    currencyCode: currency,
  };
}

export async function createBindingAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const elementId = errors.need("elementId", text(form, "elementId"));
  const input = await bindingInput(form, errors, ctx.viewer.db);
  if (errors.any || !elementId) return errors.state;
  return finish(
    await createCatalogBinding(ctx.viewer.db, ctx.org.id, { ...input, elementId }),
    ctx,
    MODULE,
  );
}

export async function updateBindingAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const errors = new FieldErrors();
  const input = await bindingInput(form, errors, ctx.viewer.db);
  if (id === null) return { error: "notFound" };
  if (errors.any) return errors.state;
  return finish(await updateCatalogBinding(ctx.viewer.db, id, input), ctx, MODULE);
}

export async function deleteBindingAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await deleteCatalogBinding(ctx.viewer.db, id), ctx, MODULE);
}

export async function createProductAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const vendorId = errors.need("vendorId", uuid(form, "vendorId"));
  const sku = errors.need("vendorSku", requiredText(form, "vendorSku", 100));
  const currency = text(form, "currencyCode")?.toUpperCase() ?? null;
  const price = moneyToMinor(text(form, "unitPrice"), await exponentOf(ctx.viewer.db, currency));
  if (price === undefined) errors.add("unitPrice", "money");
  if (price !== null && price !== undefined && currency === null)
    errors.add("currencyCode", "currencyNeeded");
  const lead = integer(form, "leadTimeDays", 0, 3650);
  if (lead === undefined) errors.add("leadTimeDays", "wholeNumber");
  if (errors.any || !vendorId || !sku) return errors.state;
  return finish(
    await createVendorProduct(ctx.viewer.db, {
      vendorId,
      catalogBindingId: uuid(form, "catalogBindingId"),
      vendorSku: sku,
      unitPriceMinor: price ?? null,
      currencyCode: currency,
      leadTimeDays: lead ?? null,
    }),
    ctx,
    MODULE,
  );
}

export async function deleteProductAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await deleteVendorProduct(ctx.viewer.db, id), ctx, MODULE);
}

// Submittals -----------------------------------------------------------------------------------------------

function submittalInput(form: FormData, errors: FieldErrors) {
  const kind = text(form, "kind") as SubmittalKind | null;
  if (!kind || !SUBMITTAL_KINDS.includes(kind)) errors.add("kind", "required");
  const title = errors.need("title", requiredText(form, "title", 200));
  const dueOn = isoDate(form, "dueOn");
  if (dueOn === undefined) errors.add("dueOn", "date");
  return {
    kind: (kind ?? "Other") as SubmittalKind,
    title: title ?? "",
    specReference: text(form, "specReference"),
    dueOn: dueOn ?? null,
    purchaseOrderId: uuid(form, "purchaseOrderId"),
  };
}

export async function createSubmittalAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const projectId = errors.need("projectId", uuid(form, "projectId"));
  const vendorId = errors.need("vendorId", uuid(form, "vendorId"));
  const input = submittalInput(form, errors);
  if (errors.any || !projectId || !vendorId) return errors.state;
  return finish(
    await createSubmittal(ctx.viewer.db, { ...input, projectId, vendorId }),
    ctx,
    MODULE,
  );
}

export async function updateSubmittalAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const errors = new FieldErrors();
  const input = submittalInput(form, errors);
  if (id === null) return { error: "notFound" };
  if (errors.any) return errors.state;
  return finish(await updateSubmittal(ctx.viewer.db, id, input), ctx, MODULE);
}

export async function transitionSubmittalAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const reason = reasonOf(form);
  if (reason === null) return { fieldErrors: { reason: "required" } };
  const m = move<ReviewState>(form, REVIEW_STATES);
  if (!m) return { error: "invalid" };
  return finish(await transitionSubmittal(ctx.viewer.db, { ...m, reason }), ctx, MODULE);
}
