"use server";

import {
  clearFlagOverride,
  endPlanOverride,
  resolveBillingAlert,
  setFlagOverride,
  setKillSwitch,
  setPartnerClients,
  setPlanOverride,
  type PlanOverrideChange,
} from "@xos/data/console";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/operator";
import { expiryFrom, failed, field, fromResult, type ActionState } from "@/lib/action-state";

/**
 * Plan overrides and feature flags from a tenant's page (A90, migration 1471). Each action checks the operator and
 * the second factor first and the database checks them again; every change lands in the console ledger and the
 * tenant's audit log.
 */

const Uuid = z.uuid();

function planChange(form: FormData): PlanOverrideChange | null {
  const kind = field(form, "kind");
  if (kind === "Plan") {
    const planCode = field(form, "planCode");
    return planCode ? { kind, planCode } : null;
  }
  if (kind === "Feature") {
    const featureCode = field(form, "featureCode");
    const enabled = field(form, "enabled");
    return featureCode && (enabled === "on" || enabled === "off")
      ? { kind, featureCode, enabled: enabled === "on" }
      : null;
  }
  if (kind === "Limit") {
    const limitCode = field(form, "limitCode");
    const raw = field(form, "limitValue");
    if (!limitCode) return null;
    if (raw === "") return { kind, limitCode, limitValue: null };
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? { kind, limitCode, limitValue: value } : null;
  }
  return null;
}

export async function setPlanOverrideAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext("plans.write");
  if (!ctx.ok) return failed(ctx.key);
  const orgId = field(form, "orgId");
  const change = planChange(form);
  const expiresAt = expiryFrom(field(form, "days"));
  const reason = field(form, "reason");
  if (!Uuid.safeParse(orgId).success || !change || !expiresAt || reason === "") {
    return failed("errors.invalid");
  }
  const result = await setPlanOverride(ctx.db, { orgId, change, reason, expiresAt });
  if (result.ok) revalidatePath(`/tenants/${orgId}`);
  return fromResult(result);
}

export async function endPlanOverrideAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext("plans.write");
  if (!ctx.ok) return failed(ctx.key);
  const orgId = field(form, "orgId");
  const overrideId = field(form, "overrideId");
  const reason = field(form, "reason");
  if (!Uuid.safeParse(overrideId).success || reason === "") return failed("errors.invalid");
  const result = await endPlanOverride(ctx.db, overrideId, reason);
  if (result.ok) revalidatePath(`/tenants/${orgId}`);
  return fromResult(result);
}

/** Closes a billing alert once it is dealt with, such as a charge refunded by hand (ADR 0161). */
export async function resolveBillingAlertAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext("plans.write");
  if (!ctx.ok) return failed(ctx.key);
  const alertId = field(form, "alertId");
  const reason = field(form, "reason");
  if (!Uuid.safeParse(alertId).success || reason === "") return failed("errors.invalid");
  const result = await resolveBillingAlert(ctx.db, alertId, reason);
  if (result.ok) revalidatePath("/tenants");
  return fromResult(result);
}

export async function setFlagOverrideAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext("flags.write");
  if (!ctx.ok) return failed(ctx.key);
  const orgId = field(form, "orgId");
  const flagKey = field(form, "flagKey");
  const enabled = field(form, "enabled");
  const expiresAt = expiryFrom(field(form, "days"));
  const reason = field(form, "reason");
  if (
    !Uuid.safeParse(orgId).success ||
    flagKey === "" ||
    (enabled !== "on" && enabled !== "off") ||
    !expiresAt ||
    reason === ""
  ) {
    return failed("errors.invalid");
  }
  const result = await setFlagOverride(ctx.db, {
    orgId,
    flagKey,
    enabled: enabled === "on",
    reason,
    expiresAt,
  });
  if (result.ok) revalidatePath(`/tenants/${orgId}`);
  return fromResult(result);
}

export async function clearFlagOverrideAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext("flags.write");
  if (!ctx.ok) return failed(ctx.key);
  const orgId = field(form, "orgId");
  const overrideId = field(form, "overrideId");
  const reason = field(form, "reason");
  if (!Uuid.safeParse(overrideId).success || reason === "") return failed("errors.invalid");
  const result = await clearFlagOverride(ctx.db, overrideId, reason);
  if (result.ok) revalidatePath(`/tenants/${orgId}`);
  return fromResult(result);
}

/** Client org creation for a partner (migration 6870): off by default, turned on under a signed partner agreement. */
export async function setPartnerClientsAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext("plans.write");
  if (!ctx.ok) return failed(ctx.key);
  const orgId = field(form, "orgId");
  const enabled = field(form, "enabled");
  const reason = field(form, "reason");
  if (!Uuid.safeParse(orgId).success || (enabled !== "on" && enabled !== "off") || reason === "") {
    return failed("errors.invalid");
  }
  const result = await setPartnerClients(ctx.db, { orgId, allowed: enabled === "on", reason });
  if (result.ok) revalidatePath(`/tenants/${orgId}`);
  return fromResult(result);
}

export async function setKillSwitchAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext("flags.kill_switch");
  if (!ctx.ok) return failed(ctx.key);
  const flagKey = field(form, "flagKey");
  const kill = field(form, "kill");
  const reason = field(form, "reason");
  if (flagKey === "" || (kill !== "on" && kill !== "off") || reason === "") {
    return failed("errors.invalid");
  }
  const result = await setKillSwitch(ctx.db, { flagKey, kill: kill === "on", reason });
  if (result.ok) revalidatePath("/flags");
  return fromResult(result);
}
