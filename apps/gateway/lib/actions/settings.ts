"use server";

import { clearPersonalSetting, setPersonalSetting } from "@xos/data/settings";
import { createServerSupabase } from "@/lib/supabase/server";
import { parseSettingValue, settingByKey } from "@/lib/settings";

/** Saves or clears one personal setting (A30 app.set_personal_setting, for every org). */
export interface SettingState {
  /** A `settings.errors.*` key. */
  readonly error?: string;
  readonly saved?: number;
}

function errorKey(error: { kind: string; rule?: string }): string {
  if (error.kind === "refusal") return error.rule ?? "unexpected";
  if (error.kind === "not-found") return "denied";
  return error.kind === "conflict" || error.kind === "invalid" ? error.kind : "unexpected";
}

export async function savePersonalSettingAction(prev: SettingState, form: FormData): Promise<SettingState> {
  const def = settingByKey(String(form.get("key") ?? ""));
  if (!def || !def.scopes.includes("personal")) return { error: "setting_unknown" };
  const db = await createServerSupabase();
  if (form.get("intent") === "reset") {
    const cleared = await clearPersonalSetting(db, { key: def.key });
    return cleared.ok ? { saved: (prev.saved ?? 0) + 1 } : { error: errorKey(cleared.error) };
  }
  const parsed = parseSettingValue(def, typeof form.get("value") === "string" ? (form.get("value") as string) : null);
  if (!parsed.ok) return { error: parsed.error };
  const result = await setPersonalSetting(db, { key: def.key, value: parsed.value });
  if (!result.ok) {
    if (result.error.kind === "unexpected") console.error("set_personal_setting failed", result.error);
    return { error: errorKey(result.error) };
  }
  return { saved: (prev.saved ?? 0) + 1 };
}
