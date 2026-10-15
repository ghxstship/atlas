"use server";

import {
  applicationMode,
  applyToOpportunity,
  getOpportunity,
  removeSavedSearch,
  saveOpportunity,
  unsaveOpportunity,
  reportListing,
  saveSearch,
  setSavedSearchAlerts,
  shareProfile,
  submitBid,
  submitSlate,
  APP_ENUMS,
} from "@xos/data/gateway";
import { z } from "zod";
import { outcomeFor, toAction, type ActionResult } from "@/lib/action-result";
import { parseMoneyInput } from "@/lib/format";
import { getGatewayContext } from "@/lib/shell/context";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Marketplace server actions (Section 4.4.3): apply in one step with a consent snapshot, a sealed
 * bid, an agency slate, saved searches and listing reports. The database refuses a closed
 * deadline, a hidden listing and a Do Not Engage flag with the same refusal, so a flag never shows.
 */

export interface ApplyState {
  /** `gateway.explore.applyForm.errors.*` key for a field problem the form can fix. */
  readonly fieldError?: string;
  /** `gateway.outcomes.*` key for a database outcome. */
  readonly outcome?: string;
  readonly sent?: boolean;
}

const LISTING_REASONS = APP_ENUMS.listing_report_reason;

function strings(form: FormData, name: string): string[] {
  return form.getAll(name).map((v) => (typeof v === "string" ? v.trim() : ""));
}

export async function applyAction(_: ApplyState, form: FormData): Promise<ApplyState> {
  const ctx = await getGatewayContext();
  if (!ctx) return { outcome: "notFound" };
  const opportunityId = z.uuid().safeParse(form.get("opportunityId"));
  if (!opportunityId.success) return { outcome: "invalid" };
  const detail = await getOpportunity(ctx.db, opportunityId.data);
  if (!detail.ok) return { outcome: outcomeFor(detail.error) };
  const opp = detail.data;
  const account = ctx.acting;
  const mode = applicationMode(opp.roleType, opp.rateType, account !== null);
  if (form.get("available") !== "on") return { fieldError: "available" };

  const answers = opp.questions.map((q) => ({
    questionId: q.id,
    text: String(form.get(`q_${q.id}`) ?? "").trim(),
  }));
  if (opp.questions.some((q, i) => q.required && (answers[i]?.text ?? "") === "")) {
    return { fieldError: "answer" };
  }

  const currency = opp.currency ?? "USD";
  const feeText = String(form.get("fee") ?? "").trim();
  const fee = feeText === "" ? null : parseMoneyInput(feeText, currency);
  if (feeText !== "" && fee === null) return { fieldError: "fee" };

  const lines =
    mode === "bid"
      ? strings(form, "lineDescription")
          .map((description, i) => ({
            description,
            quantity: Number(strings(form, "lineQuantity")[i] ?? "0"),
            unitPriceMinor: parseMoneyInput(strings(form, "linePrice")[i] ?? "", currency),
          }))
          .filter((l) => l.description !== "")
      : [];
  if (mode === "bid" && (lines.length === 0 || lines.some((l) => !(l.quantity > 0)))) {
    return { fieldError: "bidLines" };
  }
  const slate =
    mode === "slate" ? strings(form, "slate").filter((s) => z.uuid().safeParse(s).success) : [];
  if (mode === "slate" && slate.length === 0) return { fieldError: "slate" };

  const fields: { key: string; value: string }[] = [];
  if (form.get("share_full_name") === "on" && ctx.personName) {
    fields.push({ key: "full_name", value: ctx.personName });
  }
  if (form.get("share_email") === "on" && ctx.email)
    fields.push({ key: "email", value: ctx.email });
  if (account && form.get("share_company_name") === "on") {
    fields.push({ key: "company.name", value: account.name });
  }
  let profileShareId: string | null = null;
  if (fields.length > 0) {
    const share = await shareProfile(ctx.db, {
      orgId: opp.orgId,
      fields,
      accountId: account && mode !== "person" && mode !== "artist" ? account.id : null,
    });
    if (!share.ok) return { outcome: outcomeFor(share.error) };
    profileShareId = share.data.profileShareId;
  }

  const asAccount = account !== null && (mode === "bid" || mode === "slate");
  const applied = await applyToOpportunity(ctx.db, {
    opportunityId: opp.id,
    applicantPersonId: asAccount ? null : ctx.personId,
    applicantOrganizationId: asAccount ? account.id : null,
    profileShareId,
    availabilityConfirmed: true,
    coverNote: String(form.get("coverNote") ?? "").trim() || null,
    proposedFeeMinor: mode === "artist" || mode === "person" ? fee : null,
    currency,
    answers,
  });
  if (!applied.ok) return { outcome: outcomeFor(applied.error) };

  if (mode === "bid") {
    const validUntil = z.iso.date().safeParse(form.get("validUntil"));
    const bid = await submitBid(ctx.db, {
      applicationId: applied.data.applicationId,
      currency,
      validUntil: validUntil.success ? validUntil.data : null,
      lines,
    });
    if (!bid.ok) return { outcome: outcomeFor(bid.error) };
  }
  if (mode === "slate") {
    const sent = await submitSlate(ctx.db, {
      applicationId: applied.data.applicationId,
      personIds: slate,
    });
    if (!sent.ok) return { outcome: outcomeFor(sent.error) };
  }
  return { sent: true };
}

export interface SimpleState {
  readonly outcome?: string;
  readonly done?: boolean;
}

export async function saveSearchAction(_: SimpleState, form: FormData): Promise<SimpleState> {
  const ctx = await getGatewayContext();
  if (!ctx) return { outcome: "notFound" };
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(200),
      roleType: z.string().optional(),
      startsAfter: z.iso.date().optional(),
      endsBefore: z.iso.date().optional(),
    })
    .safeParse({
      name: form.get("name"),
      roleType: form.get("roleType") || undefined,
      startsAfter: form.get("startsAfter") || undefined,
      endsBefore: form.get("endsBefore") || undefined,
    });
  if (!parsed.success) return { outcome: "invalid" };
  const roleType = z.enum(APP_ENUMS.external_role_type).safeParse(parsed.data.roleType);
  const result = await saveSearch(ctx.db, {
    personId: ctx.personId,
    name: parsed.data.name,
    roleType: roleType.success ? roleType.data : null,
    startsAfter: parsed.data.startsAfter ?? null,
    endsBefore: parsed.data.endsBefore ?? null,
    orgId: null,
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function reportListingAction(_: SimpleState, form: FormData): Promise<SimpleState> {
  const parsed = z
    .object({
      opportunityId: z.uuid(),
      reason: z.enum(LISTING_REASONS),
      details: z.string().max(4000),
    })
    .safeParse({
      opportunityId: form.get("opportunityId"),
      reason: form.get("reason"),
      details: form.get("details") ?? "",
    });
  if (!parsed.success) return { outcome: "invalid" };
  const result = await reportListing(await createServerSupabase(), parsed.data);
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function setAlertsAction(
  savedSearchId: string,
  enabled: boolean,
): Promise<ActionResult> {
  return toAction(
    await setSavedSearchAlerts(await createServerSupabase(), {
      id: z.uuid().parse(savedSearchId),
      enabled,
    }),
  );
}

export async function removeSavedSearchAction(savedSearchId: string): Promise<ActionResult> {
  return toAction(
    await removeSavedSearch(await createServerSupabase(), z.uuid().parse(savedSearchId)),
  );
}

export async function saveOpportunityAction(opportunityId: string): Promise<ActionResult> {
  const ctx = await getGatewayContext();
  if (!ctx) return { ok: false, outcome: "notFound" };
  return toAction(
    await saveOpportunity(ctx.db, {
      personId: ctx.personId,
      opportunityId: z.uuid().parse(opportunityId),
    }),
  );
}

export async function unsaveOpportunityAction(savedId: string): Promise<ActionResult> {
  return toAction(await unsaveOpportunity(await createServerSupabase(), z.uuid().parse(savedId)));
}
