import { OfferingRules } from "@/components/projects/offering-rules";
import { getTranslate } from "@/lib/shell/translate";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * R3's panel on Settings > Gateway and marketplace (owner decision 7): the org's audience rules for
 * its offerings, for one role type or vendor class across every project, with optional caps. The
 * nine offerings.* values and their locks render above it through the registry section. Editing
 * needs projects.settings.write; the app.offering_rules policies decide every write.
 */
async function OrgOfferingRulesPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  return (
    <section
      aria-labelledby="org-offering-rules"
      className="flex max-w-layout-form flex-col gap-12"
      data-testid="org-offering-rules"
    >
      <header className="flex flex-col gap-4">
        <h2 id="org-offering-rules" className="m-0 text-heading-16 font-semibold">
          {t("projects.settings.offerings.orgTitle")}
        </h2>
        <p className="m-0 text-text-13 text-text-secondary">
          {t("projects.settings.offerings.orgDescription")}
        </p>
      </header>
      <OfferingRules
        t={t}
        db={ctx.viewer.db}
        orgId={ctx.org.id}
        scope={{ org: ctx.org.slug, projectId: "", projectKey: "" }}
        canEdit={ctx.capabilities.has("projects.settings.write")}
        headingId="org-offering-rules"
      />
    </section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.gateway-and-marketplace", order: 50, Panel: OrgOfferingRulesPanel },
];
