"use server";

import {
  clearPersonalSetting,
  clearSetting,
  setPersonalSetting,
  setSetting,
  type SettingScopeKind,
} from "@xos/data/settings";
import { networkAccess } from "@xos/data/access-controls";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { z } from "zod";
import { clientIp } from "@/lib/auth/legal";
import { parseSettingValue, settingByKey, settingErrorKey } from "@/lib/settings/registry";
import { getOrgContext } from "@/lib/shell/context";
import { applyDevicePreference } from "@/lib/shell/actions";

/**
 * Saves the changed registered settings of one settings form (Section 4.5.6, A59-018): an org,
 * workspace, team or project value, optionally locked, or the signed-in person's own value. The
 * form names the settings the person changed (`dirty`), those to reset to the inherited value
 * (`clear`), and each value as `value:<key>` and lock as `locked:<key>`. Every setting saves on its
 * own: one refused value does not stop the others. The database decides every write (migration
 * 0850); refusals come back per setting as `settings.errors.*` keys.
 */

export interface SettingsFormState {
  /** Refusal key per setting that did not save. */
  readonly errors?: Readonly<Record<string, string>>;
  /** The text submitted for each setting that did not save, so a failed save loses nothing. */
  readonly values?: Readonly<Record<string, string>>;
  /** Settings that saved in this submission. */
  readonly saved?: readonly string[];
  /** Changes with every submission, so the form can tell one result from the next. */
  readonly at?: number;
}

const SCOPE_KINDS = ["Organization", "Workspace", "Team", "Project"] as const;

const formSchema = z.object({
  org: z.string().min(1),
  group: z.enum(["org", "personal"]),
  scopeKind: z.enum(SCOPE_KINDS).optional(),
  scopeId: z.uuid().optional(),
});

function field(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value !== "" ? value : undefined;
}

function strings(form: FormData, name: string): string[] {
  return form.getAll(name).filter((v): v is string => typeof v === "string" && v !== "");
}

export async function saveSettingsAction(
  _: SettingsFormState,
  form: FormData,
): Promise<SettingsFormState> {
  const at = Date.now();
  const parsed = formSchema.safeParse({
    org: field(form, "org"),
    group: field(form, "group"),
    scopeKind: field(form, "scopeKind"),
    scopeId: field(form, "scopeId"),
  });
  const keys = [...new Set(strings(form, "dirty"))];
  if (!parsed.success) {
    return { errors: Object.fromEntries(keys.map((k) => [k, "unexpected"])), at };
  }
  const input = parsed.data;
  const ctx = await getOrgContext(input.org);
  if (!ctx) notFound();
  const clears = new Set(strings(form, "clear"));
  const perOrg = new Set(strings(form, "perOrg"));
  const scopeKind: SettingScopeKind = input.scopeKind ?? "Organization";
  const scopeId = scopeKind === "Organization" ? ctx.org.id : input.scopeId;

  const errors: Record<string, string> = {};
  const values: Record<string, string> = {};
  const saved: string[] = [];
  for (const key of keys) {
    const def = settingByKey(key);
    if (!def) {
      errors[key] = "setting_unknown";
      continue;
    }
    const value = form.get(`value:${key}`);
    const raw = typeof value === "string" ? value : null;
    const refuse = (error: string) => {
      errors[key] = error;
      values[key] = raw ?? "";
    };
    if (input.group === "org" && scopeId === undefined) {
      refuse("unexpected");
      continue;
    }
    const ownOrg = perOrg.has(key) ? { orgId: ctx.org.id } : {};
    let result;
    if (clears.has(key)) {
      result =
        input.group === "personal"
          ? await clearPersonalSetting(ctx.viewer.db, { key: def.key, ...ownOrg })
          : await clearSetting(ctx.viewer.db, {
              orgId: ctx.org.id,
              key: def.key,
              scopeKind,
              scopeId: scopeId as string,
            });
    } else {
      const next = parseSettingValue(def, raw);
      if (!next.ok) {
        refuse(next.error);
        continue;
      }
      // Turning the IP allow-list on (migration 1201) must keep the person who does it inside.
      if (def.key === "security.ip_allowlist" && next.value === true && input.group === "org") {
        const access = await networkAccess(ctx.viewer.db, ctx.org.id, clientIp(await headers()));
        if (!access.ok) {
          refuse(settingErrorKey(access.error));
          continue;
        }
        if (!access.data.covered) {
          refuse("ip_allowlist_self_lockout");
          continue;
        }
      }
      result =
        input.group === "personal"
          ? await setPersonalSetting(ctx.viewer.db, { key: def.key, value: next.value, ...ownOrg })
          : await setSetting(ctx.viewer.db, {
              orgId: ctx.org.id,
              key: def.key,
              scopeKind,
              scopeId: scopeId as string,
              value: next.value,
              locked:
                def.lockable && scopeKind === "Organization" && form.get(`locked:${key}`) === "on",
            });
    }
    if (!result.ok) {
      refuse(settingErrorKey(result.error));
      continue;
    }
    saved.push(key);
    // A theme or language saved here applies on this device at once, as the shell's pickers do. The
    // display preferences follow through the shell, which re-resolves them on the next render.
    if (input.group === "personal" && !clears.has(key) && raw !== null) {
      await applyDevicePreference(def.key, raw.trim());
    }
  }
  if (saved.length > 0) revalidatePath(`/${ctx.org.slug}`, "layout");
  return { errors, values, saved, at };
}
