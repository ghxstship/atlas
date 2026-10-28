import { can, listFlags } from "@xos/data/console";
import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { ReasonField } from "@/components/fields";
import { Empty, PageHeader, Table } from "@/components/page";
import { setKillSwitchAction } from "@/lib/actions/tenants";
import { getConsoleFormat } from "@/lib/format";
import { requirePermission } from "@/lib/operator";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getConsoleFormat();
  return { title: t("flags.title") };
}

/** Feature flags (Section 5.1): defaults, plan requirements, live per-org overrides and the kill switch. */
export default async function FlagsPage() {
  const ctx = await requirePermission("tenants.read");
  const { t, label } = await getConsoleFormat();
  const result = await listFlags(ctx.db);
  const kill = can(ctx.operator, "flags.kill_switch");
  if (!result.ok) {
    return (
      <>
        <PageHeader title={t("flags.title")} intro={t("flags.intro")} />
        <Empty>{t("common.loadError")}</Empty>
      </>
    );
  }
  return (
    <>
      <PageHeader title={t("flags.title")} intro={t("flags.intro")} />
      <Table
        caption={t("flags.title")}
        testId="flags"
        columns={[
          t("flags.flag"),
          t("flags.default"),
          t("flags.planGate"),
          t("flags.overrides"),
          t("flags.killSwitch"),
        ]}
        rows={result.data.map((flag) => ({
          key: flag.flagKey,
          cells: [
            <span key="flag" className="flex flex-col gap-4">
              <code className="font-mono">{flag.flagKey}</code>
              <span className="text-text-12 text-text-secondary">{flag.description}</span>
            </span>,
            flag.defaultEnabled ? t("common.on") : t("common.off"),
            flag.requiredPlanFeature
              ? label("featureNames", flag.requiredPlanFeature)
              : t("common.none"),
            t("flags.overridesCount", { on: flag.overridesOn, off: flag.overridesOff }),
            <span key="kill" className="flex flex-col gap-8">
              <span>{flag.killSwitch ? t("flags.killed") : t("flags.notKilled")}</span>
              {kill ? (
                <ActionForm
                  action={setKillSwitchAction}
                  hidden={{ flagKey: flag.flagKey, kill: flag.killSwitch ? "off" : "on" }}
                  submitLabel={flag.killSwitch ? t("flags.killOff") : t("flags.killOn")}
                  successLabel={t("flags.saved")}
                  variant={flag.killSwitch ? "secondary" : "danger"}
                  label={t("flags.killSwitchFor", { flag: flag.flagKey })}
                >
                  <ReasonField t={t} id={`kill-${flag.flagKey}`} />
                </ActionForm>
              ) : null}
            </span>,
          ],
        }))}
      />
    </>
  );
}
