"use server";

import { requireSecondFactor } from "@xos/data/auth-assurance";
import {
  addOfferedCapability,
  addServiceRegion,
  myOwnerRoleId,
  removeProfileEntry,
  saveAccountNotificationDefaults,
} from "@xos/data/company-settings";
import { revokeConnectedApp } from "@xos/data/connected-apps";
import { createPersonalToken, revokePersonalToken } from "@xos/data/developer";
import { removeAccountRole } from "@xos/data/account-roles";
import { addAccountMember } from "@xos/data/gateway";
import { PARTY_CATEGORIES, partyChannels } from "@xos/data/party-notifications";
import { z } from "zod";
import type { SimpleFormState } from "@/components/forms/simple-form";
import { outcomeFor, toAction, type ActionResult } from "@/lib/action-result";
import { getGatewayContext } from "@/lib/shell/context";

/**
 * Gateway actions of the A86 settings surfaces (RRR-131, finding A65-004): connected apps and personal API tokens
 * (personal settings items 13 and 15), and the company's regions, capabilities, ownership and notification
 * defaults (company settings items 3, 7 and 8). Row level security and the RPCs decide every write; refusals come
 * back as `gateway.outcomes` keys.
 */

export interface SecretFormState extends SimpleFormState {
  /** A new token's secret, shown once. */
  readonly secret?: string;
  /** The action needs a recent second factor first (A77's step-up). */
  readonly stepUp?: boolean;
}

async function ctxOr() {
  const ctx = await getGatewayContext();
  if (!ctx) throw new Error("A signed-in person is required.");
  return ctx;
}

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}

const id = z.uuid();
const EXPIRY_DAYS = new Set(["30", "90", "180", "365"]);

// Personal: connected apps and tokens ------------------------------------------------------------------------

export async function revokeConnectedAppAction(grantId: string): Promise<ActionResult> {
  const ctx = await ctxOr();
  return toAction(await revokeConnectedApp(ctx.db, id.parse(grantId)));
}

export async function revokePersonalTokenAction(tokenId: string): Promise<ActionResult> {
  const ctx = await ctxOr();
  return toAction(await revokePersonalToken(ctx.db, id.parse(tokenId)));
}

export async function createPersonalTokenAction(
  _: SecretFormState,
  form: FormData,
): Promise<SecretFormState> {
  const ctx = await ctxOr();
  const orgId = id.safeParse(text(form, "orgId"));
  const name = text(form, "name");
  const scopes = form
    .getAll("scopes")
    .flatMap((s) => (typeof s === "string" && s !== "" ? [s] : []));
  const expires = text(form, "expiresIn") || "90";
  if (
    !orgId.success ||
    name === "" ||
    name.length > 200 ||
    scopes.length === 0 ||
    !EXPIRY_DAYS.has(expires)
  ) {
    return { outcome: "invalid" };
  }
  // A token acts as the person: issuing one needs a recent second factor (A77, migration 1333).
  const stepUp = await requireSecondFactor(ctx.db);
  if (!stepUp.ok) return { outcome: `refusals.${stepUp.rule}`, stepUp: true };
  const result = await createPersonalToken(ctx.db, {
    orgId: orgId.data,
    name,
    scopes,
    expiresAt: new Date(Date.now() + Number(expires) * 86_400_000).toISOString(),
  });
  if (!result.ok) {
    const outcome = outcomeFor(result.error);
    return { outcome, ...(outcome === "refusals.step_up_required" ? { stepUp: true } : {}) };
  }
  return { done: true, secret: result.data.secret };
}

// Company: regions and capabilities --------------------------------------------------------------------------

export async function addServiceRegionAction(
  _: SimpleFormState,
  form: FormData,
): Promise<SimpleFormState> {
  const ctx = await ctxOr();
  if (!ctx.acting) return { outcome: "notFound" };
  const jurisdiction = text(form, "jurisdictionId");
  if (!/^[A-Z]{2}(-[A-Z0-9]+)*$/.test(jurisdiction)) return { fieldError: "jurisdiction" };
  const result = await addServiceRegion(ctx.db, ctx.acting.id, jurisdiction);
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function addCapabilityAction(
  _: SimpleFormState,
  form: FormData,
): Promise<SimpleFormState> {
  const ctx = await ctxOr();
  if (!ctx.acting) return { outcome: "notFound" };
  const category = text(form, "categoryUrid");
  if (!/^[0-9]{4}\.[0-9]{2}\.[0-9]{2}$/.test(category)) return { fieldError: "category" };
  const result = await addOfferedCapability(ctx.db, ctx.acting.id, category);
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function removeRegionAction(regionId: string): Promise<ActionResult> {
  const ctx = await ctxOr();
  return toAction(
    await removeProfileEntry(ctx.db, "organization_service_regions", id.parse(regionId)),
  );
}

export async function removeCapabilityAction(capabilityId: string): Promise<ActionResult> {
  const ctx = await ctxOr();
  return toAction(
    await removeProfileEntry(ctx.db, "organization_profile_capabilities", id.parse(capabilityId)),
  );
}

// Company: ownership -----------------------------------------------------------------------------------------

export async function makeOwnerAction(
  _: SimpleFormState,
  form: FormData,
): Promise<SimpleFormState> {
  const ctx = await ctxOr();
  if (!ctx.acting) return { outcome: "notFound" };
  const personId = id.safeParse(text(form, "personId"));
  if (!personId.success) return { fieldError: "member" };
  const result = await addAccountMember(ctx.db, {
    accountId: ctx.acting.id,
    personId: personId.data,
    role: "Account Owner",
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

/** Removes the caller's own Account Owner role; the last Account Owner always stays. */
export async function stepDownAction(membershipId: string): Promise<ActionResult> {
  const ctx = await ctxOr();
  const role = await myOwnerRoleId(ctx.db, id.parse(membershipId));
  if (!role.ok) return toAction(role);
  if (role.data === null) return { ok: false, outcome: "notFound" };
  return toAction(await removeAccountRole(ctx.db, role.data));
}

// Company: notification defaults -----------------------------------------------------------------------------

/**
 * Saves the company's defaults for the one category its form shows, on the channels that category reaches (A104).
 * Each category has its own form, so the others keep what they hold.
 */
export async function saveCompanyDefaultsAction(
  _: SecretFormState,
  form: FormData,
): Promise<SecretFormState> {
  const ctx = await ctxOr();
  if (!ctx.acting) return { outcome: "notFound" };
  const category = PARTY_CATEGORIES.find((c) => c === form.get("category"));
  if (!category) return { outcome: "invalid" };
  const defaults = partyChannels(category).map((channel) => ({
    category,
    channel,
    enabled: form.get(`${category}.${channel}`) === "on",
  }));
  const result = await saveAccountNotificationDefaults(ctx.db, ctx.acting.id, defaults);
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}
