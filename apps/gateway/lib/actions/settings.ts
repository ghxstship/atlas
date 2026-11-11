"use server";

import { clearPersonalSetting, setPersonalSetting } from "@xos/data/settings";
import { regionFromLocale, toE164 } from "@xos/i18n/formats";
import { getLocale } from "next-intl/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { parseSettingValue, settingByKey } from "@/lib/settings";
import { setLocale } from "@/lib/shell/actions";
import { observability } from "@/lib/observability";

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

export async function savePersonalSettingAction(
  prev: SettingState,
  form: FormData,
): Promise<SettingState> {
  const def = settingByKey(String(form.get("key") ?? ""));
  if (!def || !def.scopes.includes("personal")) return { error: "setting_unknown" };
  const db = await createServerSupabase();
  if (form.get("intent") === "reset") {
    const cleared = await clearPersonalSetting(db, { key: def.key });
    return cleared.ok ? { saved: (prev.saved ?? 0) + 1 } : { error: errorKey(cleared.error) };
  }
  const raw = typeof form.get("value") === "string" ? (form.get("value") as string) : null;
  // A phone is stored in E.164 (A139): what the person typed is read in their region.
  let typed = raw;
  if (def.input === "phone" && raw !== null && raw.trim() !== "") {
    typed = toE164(raw, regionFromLocale(await getLocale()));
    if (typed === null) return { error: "phone" };
  }
  const parsed = parseSettingValue(def, typed);
  if (!parsed.ok) return { error: parsed.error };
  const result = await setPersonalSetting(db, { key: def.key, value: parsed.value });
  if (!result.ok) {
    if (result.error.kind === "unexpected")
      observability.logger.error("set_personal_setting failed", { error: result.error });
    return { error: errorKey(result.error) };
  }
  // A language saved here applies on this device at once, as the account menu's picker does (A65-001).
  if (def.key === "locale.language" && typeof parsed.value === "string")
    await setLocale(parsed.value);
  return { saved: (prev.saved ?? 0) + 1 };
}
