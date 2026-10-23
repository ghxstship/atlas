import { getSubscription } from "@xos/data";
import { listAutomationRuns, listAutomations } from "@xos/data/automations";
import { AutomationsPanel } from "@/components/settings/automations/automations-panel";
import { InlineAlert } from "@/components/ui";
import { planHasFeature } from "@/lib/settings/plan";
import { getTranslate } from "@/lib/shell/translate";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A91's settings panel (RRR-136, migrations 1480 and 1481, ADR 0047, finding A65-010): Settings, Automations
 * (Section 4.5.6 item 20). The org's automations and recent runs, read with the viewer's client; the editor and run
 * details load on demand from the client panel. Writing needs org.automations.write and the automations plan feature
 * (Pro and above); without the feature the automations stay, and can be turned off and deleted.
 */
async function AutomationsSettingsPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const [automations, runs, subscription] = await Promise.all([
    listAutomations(ctx.viewer.db, ctx.org.id),
    listAutomationRuns(ctx.viewer.db, ctx.org.id, { limit: 20 }),
    getSubscription(ctx.viewer.db, ctx.org.id),
  ]);
  if (!automations.ok || !runs.ok || !subscription.ok) {
    return <InlineAlert tone="danger">{t("settings.automations.loadFailed")}</InlineAlert>;
  }
  return (
    <AutomationsPanel
      org={ctx.org.slug}
      canEdit={ctx.capabilities.has("org.automations.write")}
      inPlan={planHasFeature(subscription.data.planCode, "automations")}
      automations={automations.data.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        triggerEventType: a.triggerEventType,
        enabled: a.enabled,
        pauseReason: a.pauseReason,
        ownerName: a.ownerName,
        lastRun: a.lastRun,
      }))}
      runs={runs.data.map((r) => ({
        id: r.id,
        automationId: r.automationId,
        automationName: r.automationName,
        status: r.status,
        eventType: r.eventType,
        createdAt: r.createdAt,
        durationMs: r.durationMs,
      }))}
    />
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.automations", order: 10, Panel: AutomationsSettingsPanel },
];
