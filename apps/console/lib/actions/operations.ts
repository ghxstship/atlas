"use server";

import {
  decideAppeal,
  decideListing,
  endBanner,
  endSupportSession,
  grantOperator,
  groundsFor,
  revokeOperator,
  saveBanner,
  type BannerAudience,
  type ConsoleBanner,
  type ModerationAction,
  type ModerationGround,
  type OperatorRole,
} from "@xos/data/console";
import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { actionContext } from "@/lib/operator";
import { failed, field, fromResult, type ActionState } from "@/lib/action-state";

/**
 * Support sessions, moderation, system banners and the platform team (A90, migrations 1470, 1472 to 1474). Each
 * action checks the operator, the permission and the second factor, and the database checks them again.
 */

const Uuid = z.uuid();
const ACTIONS: readonly ModerationAction[] = ["Removed", "Restricted", "Restored", "No Action"];
const GROUNDS: readonly ModerationGround[] = ["Illegal Content", "Terms Violation", "No Violation"];
const KINDS: readonly ConsoleBanner["kind"][] = [
  "Maintenance",
  "Incident",
  "Plan Notice",
  "Notice",
];
const SEVERITIES: readonly ConsoleBanner["severity"][] = ["Info", "Warning", "Critical"];
const AUDIENCES: readonly BannerAudience[] = ["Everyone", "Atlas", "Gateway", "Compass"];
const ROLES: readonly OperatorRole[] = ["Support", "Trust and Safety", "Administrator"];

const pick = <T extends string>(list: readonly T[], value: string): T | undefined =>
  list.find((v) => v === value);

// Support sessions -------------------------------------------------------------------------------------------------------

export async function endSupportSessionAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext("support.sessions");
  if (!ctx.ok) return failed(ctx.key);
  const sessionId = field(form, "sessionId");
  if (!Uuid.safeParse(sessionId).success) return failed("errors.invalid");
  const result = await endSupportSession(ctx.db, sessionId);
  if (!result.ok) return fromResult(result);
  revalidatePath("/support");
  redirect("/support" as Route);
}

// Moderation -------------------------------------------------------------------------------------------------------------

export async function decideListingAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext("moderation.decide");
  if (!ctx.ok) return failed(ctx.key);
  const opportunityId = field(form, "opportunityId");
  const action = pick(ACTIONS, field(form, "action"));
  const ground = pick(GROUNDS, field(form, "ground"));
  const ruleReference = field(form, "ruleReference");
  const facts = field(form, "facts");
  const statement = field(form, "statement");
  if (!Uuid.safeParse(opportunityId).success || !action || !ground) return failed("errors.invalid");
  if (!groundsFor(action).includes(ground)) return failed("refusals.moderation_ground");
  if (ruleReference === "" || facts === "" || statement === "") return failed("errors.invalid");
  const result = await decideListing(ctx.db, {
    opportunityId,
    action,
    ground,
    ruleReference,
    facts,
    statement,
  });
  if (result.ok) {
    revalidatePath(`/moderation/${opportunityId}`);
    revalidatePath("/moderation");
  }
  return fromResult(result);
}

export async function decideAppealAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext("moderation.decide");
  if (!ctx.ok) return failed(ctx.key);
  const opportunityId = field(form, "opportunityId");
  const appealId = field(form, "appealId");
  const outcome = field(form, "outcome");
  const statement = field(form, "statement");
  if (
    !Uuid.safeParse(appealId).success ||
    (outcome !== "Upheld" && outcome !== "Reversed") ||
    statement === ""
  ) {
    return failed("errors.invalid");
  }
  const action = pick(ACTIONS, field(form, "action"));
  const ground = pick(GROUNDS, field(form, "ground"));
  const newDecision =
    outcome === "Reversed" && action && ground
      ? {
          action,
          ground,
          ruleReference: field(form, "ruleReference"),
          facts: field(form, "facts"),
        }
      : null;
  const result = await decideAppeal(ctx.db, { appealId, outcome, statement, newDecision });
  if (result.ok) {
    revalidatePath(`/moderation/${opportunityId}`);
    revalidatePath("/moderation");
  }
  return fromResult(result);
}

// System banners ---------------------------------------------------------------------------------------------------------

/** A datetime-local value read as an instant in the operator's time zone offset, sent by the form. */
function instant(local: string, offsetMinutes: string): string | null {
  if (local === "") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  const offset = Number(offsetMinutes);
  if (!match || !Number.isInteger(offset) || Math.abs(offset) > 14 * 60) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  return new Date(Date.UTC(y, mo - 1, d, h, mi) + offset * 60_000).toISOString();
}

export async function saveBannerAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext("banners.write");
  if (!ctx.ok) return failed(ctx.key);
  const kind = pick(KINDS, field(form, "kind"));
  const severity = pick(SEVERITIES, field(form, "severity"));
  const audience = pick(AUDIENCES, field(form, "audience"));
  const message = field(form, "message");
  const offset = field(form, "offset") || "0";
  const startsRaw = field(form, "startsAt");
  const endsRaw = field(form, "endsAt");
  const startsAt = instant(startsRaw, offset);
  const endsAt = instant(endsRaw, offset);
  if (!kind || !severity || !audience || message === "") return failed("errors.invalid");
  if ((startsRaw !== "" && !startsAt) || (endsRaw !== "" && !endsAt))
    return failed("errors.invalid");
  const id = field(form, "bannerId");
  const result = await saveBanner(ctx.db, {
    id: Uuid.safeParse(id).success ? id : null,
    kind,
    severity,
    audience,
    message,
    messageEs: field(form, "messageEs") || null,
    linkUrl: field(form, "linkUrl") || null,
    startsAt,
    endsAt,
    dismissible: severity !== "Critical" && form.get("dismissible") === "on",
  });
  if (result.ok) revalidatePath("/banners");
  return fromResult(result);
}

export async function endBannerAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext("banners.write");
  if (!ctx.ok) return failed(ctx.key);
  const bannerId = field(form, "bannerId");
  if (!Uuid.safeParse(bannerId).success) return failed("errors.invalid");
  const result = await endBanner(ctx.db, bannerId);
  if (result.ok) revalidatePath("/banners");
  return fromResult(result);
}

// The platform team ------------------------------------------------------------------------------------------------------

export async function grantOperatorAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext("operators.manage");
  if (!ctx.ok) return failed(ctx.key);
  const email = field(form, "email");
  const role = pick(ROLES, field(form, "role"));
  const reason = field(form, "reason");
  if (!z.email().safeParse(email).success || !role || reason === "")
    return failed("errors.invalid");
  const result = await grantOperator(ctx.db, { email, role, reason });
  if (result.ok) revalidatePath("/team");
  return fromResult(result);
}

export async function revokeOperatorAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext("operators.manage");
  if (!ctx.ok) return failed(ctx.key);
  const grantId = field(form, "grantId");
  const reason = field(form, "reason");
  if (!Uuid.safeParse(grantId).success || reason === "") return failed("errors.invalid");
  const result = await revokeOperator(ctx.db, grantId, reason);
  if (result.ok) revalidatePath("/team");
  return fromResult(result);
}
