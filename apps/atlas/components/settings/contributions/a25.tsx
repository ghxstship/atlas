import { loadModelConfig } from "@xos/ai";
import { AI_FEATURE_ORDER, getAiAllowance, getAiSettings } from "@xos/data/ai";
import { AiFeaturesForm } from "@/components/aurora/ai-features-form";
import { InlineAlert } from "@/components/ui";
import { getTranslate } from "@/lib/shell/translate";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A25's panel on Settings, AI Features (Section 4.7, ADR 0020): the six Aurora AI switches, this
 * month's use of the plan allowance, and the model each feature uses (AI Features Notice section
 * 2). Reads run with the viewer's client, so row level security decides.
 */
async function AiFeaturesPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const [settings, allowance] = await Promise.all([
    getAiSettings(ctx.viewer.db, ctx.org.id),
    getAiAllowance(ctx.viewer.db, ctx.org.id),
  ]);
  if (!settings.ok || !allowance.ok) {
    return <InlineAlert tone="danger">{t("aurora.settings.loadFailed")}</InlineAlert>;
  }
  const config = loadModelConfig();
  const a = allowance.data;
  return (
    <section aria-labelledby="ai-features-heading" className="flex flex-col gap-12">
      <h2 id="ai-features-heading" className="m-0 text-heading-16 font-semibold">
        {t("aurora.settings.title")}
      </h2>
      <p className="m-0 max-w-layout-form text-text-13 text-text-secondary">
        {t("aurora.settings.description")}
      </p>
      {a.planIncludesAurora ? (
        <p className="m-0 text-text-13">
          {a.allowance === null
            ? t("aurora.settings.usageUnlimited", { used: String(a.used) })
            : t("aurora.settings.usage", { used: String(a.used), allowance: String(a.allowance) })}
        </p>
      ) : null}
      <AiFeaturesForm
        org={ctx.org.slug}
        canEdit={ctx.capabilities.has("org.ai.write")}
        inPlan={a.planIncludesAurora}
        features={AI_FEATURE_ORDER.map((f) => ({ feature: f, enabled: settings.data[f] }))}
      />
      <section aria-labelledby="ai-models-heading" className="flex flex-col gap-4">
        <h3 id="ai-models-heading" className="m-0 text-text-13 font-semibold">
          {t("aurora.settings.modelHeading")}
        </h3>
        <ul className="m-0 flex flex-col gap-2 ps-16 text-text-12 text-text-secondary">
          {AI_FEATURE_ORDER.map((f) => (
            <li key={f}>
              {t("aurora.settings.model", {
                feature: t(`aurora.settings.features.${f}.label`),
                model: config.modelFor(f),
              })}
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.ai-features", order: 10, Panel: AiFeaturesPanel },
];
