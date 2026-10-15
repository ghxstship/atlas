"use server";

import {
  clearPersonalSetting,
  clearSetting,
  setPersonalSetting,
  setSetting,
  type SettingScopeKind,
} from "@xos/data/settings";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { parseSettingValue, settingByKey, settingErrorKey } from "@/lib/settings/registry";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Saves one registered setting (Section 4.5.6) from a settings page: an org, workspace, team or
 * project value, optionally locked, or the signed-in person's own value. The database decides
 * every write (migration 0850); refusals come back as `settings.errors.*` keys.
 */

export interface SettingFormState {
  readonly error?: string;
  readonly ok?: boolean;
  /** The text the person submitted, kept so a failed save loses nothing. */
  readonly value?: string;
}

const SCOPE_KINDS = ["Organization", "Workspace", "Team", "Project"] as const;

const formSchema = z.object({
  org: z.string().min(1),
  key: z.string().min(1),
  group: z.enum(["org", "personal"]),
  intent: z.enum(["save", "clear"]),
  scopeKind: z.enum(SCOPE_KINDS).optional(),
  scopeId: z.uuid().optional(),
  perOrg: z.literal("on").optional(),
});

function field(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value !== "" ? value : undefined;
}

export async function saveSettingAction(
  _: SettingFormState,
  form: FormData,
): Promise<SettingFormState> {
  const parsed = formSchema.safeParse({
    org: field(form, "org"),
    key: field(form, "key"),
    group: field(form, "group"),
    intent: field(form, "intent") ?? "save",
    scopeKind: field(form, "scopeKind"),
    scopeId: field(form, "scopeId"),
    perOrg: field(form, "perOrg"),
  });
  if (!parsed.success) return { error: "unexpected" };
  const input = parsed.data;
  const ctx = await getOrgContext(input.org);
  if (!ctx) notFound();
  const def = settingByKey(input.key);
  if (!def) return { error: "setting_unknown" };
  const raw = typeof form.get("value") === "string" ? (form.get("value") as string) : null;
  const scopeKind: SettingScopeKind = input.scopeKind ?? "Organization";
  const scopeId = scopeKind === "Organization" ? ctx.org.id : input.scopeId;
  if (input.group === "org" && scopeId === undefined) return { error: "unexpected" };

  let result;
  if (input.intent === "clear") {
    result =
      input.group === "personal"
        ? await clearPersonalSetting(ctx.viewer.db, {
            key: def.key,
            ...(input.perOrg ? { orgId: ctx.org.id } : {}),
          })
        : await clearSetting(ctx.viewer.db, {
            orgId: ctx.org.id,
            key: def.key,
            scopeKind,
            scopeId: scopeId as string,
          });
  } else {
    const value = parseSettingValue(def, raw);
    if (!value.ok) return { error: value.error, value: raw ?? "" };
    result =
      input.group === "personal"
        ? await setPersonalSetting(ctx.viewer.db, {
            key: def.key,
            value: value.value,
            ...(input.perOrg ? { orgId: ctx.org.id } : {}),
          })
        : await setSetting(ctx.viewer.db, {
            orgId: ctx.org.id,
            key: def.key,
            scopeKind,
            scopeId: scopeId as string,
            value: value.value,
            locked: def.lockable && scopeKind === "Organization" && form.get("locked") === "on",
          });
  }
  if (!result.ok) return { error: settingErrorKey(result.error), value: raw ?? "" };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}
