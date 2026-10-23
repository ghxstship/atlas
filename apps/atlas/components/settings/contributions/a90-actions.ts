"use server";

import { fileModerationAppeal, grantPlatformSupportSession } from "@xos/data/platform-support";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { contextFor } from "@/lib/platform/action-context";
import {
  done,
  field,
  fromDataError,
  inputError,
  type PlatformActionState,
} from "@/lib/platform/state";

/**
 * A90's settings actions: the Owner grants the platform team a support session (Settings, Security), and the
 * affected party appeals a moderation decision (Settings, Gateway and Marketplace). Each runs as the viewer, so the
 * RPCs of migrations 1472 and 1473 decide every rule.
 */

export async function grantPlatformSupportAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ hours: z.coerce.number().int().min(1).max(24), reason: z.string().min(1).max(500) })
    .safeParse({ hours: field(form, "hours"), reason: field(form, "reason") });
  if (!parsed.success) return inputError();
  const result = await grantPlatformSupportSession(ctx.viewer.db, {
    orgId: ctx.org.id,
    ...parsed.data,
  });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/settings/security`);
  return done(result.data);
}

export async function fileModerationAppealAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const decisionId = field(form, "decision");
  const grounds = field(form, "grounds");
  if (!z.uuid().safeParse(decisionId).success || grounds.length < 1 || grounds.length > 4000) {
    return inputError();
  }
  const result = await fileModerationAppeal(ctx.viewer.db, { decisionId, grounds });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/settings/gateway-and-marketplace`);
  return done(result.data);
}
