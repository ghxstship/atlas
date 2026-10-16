"use server";

import { AI_FEATURE_ORDER, saveAiSettings, type AiFeature, type AiSettings } from "@xos/data/ai";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Saves the Aurora AI switches from Settings, AI Features (Section 4.7). Row level security lets
 * only holders of org.ai.write write them, and the database refuses turning a feature on while the
 * plan lacks aurora_ai (aurora_not_in_plan). Errors come back as `aurora.settings.errors.*` keys.
 */
export interface AiFeaturesFormState {
  readonly error?: "aurora_not_in_plan" | "generic";
  readonly ok?: boolean;
}

export async function saveAiFeaturesAction(
  _: AiFeaturesFormState,
  form: FormData,
): Promise<AiFeaturesFormState> {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  const on = new Set(form.getAll("enabled").filter((v): v is string => typeof v === "string"));
  const settings = Object.fromEntries(
    AI_FEATURE_ORDER.map((f: AiFeature) => [f, on.has(f)]),
  ) as AiSettings;
  const result = await saveAiSettings(ctx.viewer.db, ctx.org.id, settings);
  if (!result.ok) {
    return {
      error:
        result.error.kind === "refusal" && result.error.rule === "aurora_not_in_plan"
          ? "aurora_not_in_plan"
          : "generic",
    };
  }
  revalidatePath(`/${ctx.org.slug}/settings/ai-features`);
  return { ok: true };
}
