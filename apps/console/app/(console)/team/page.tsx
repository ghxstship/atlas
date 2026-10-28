import { listOperators } from "@xos/data/console";
import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { ReasonField } from "@/components/fields";
import { Empty, PageHeader, Panel, Section, Table } from "@/components/page";
import { Input, Select } from "@/components/ui";
import { grantOperatorAction, revokeOperatorAction } from "@/lib/actions/operations";
import { getConsoleFormat } from "@/lib/format";
import { requirePermission } from "@/lib/operator";

const ROLES = ["Support", "Trust and Safety", "Administrator"] as const;

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getConsoleFormat();
  return { title: t("team.title") };
}

/** The platform team (migration 1470): who holds which role, who granted and revoked it, and why. */
export default async function TeamPage() {
  const ctx = await requirePermission("operators.manage");
  const { t, label, instant } = await getConsoleFormat();
  const result = await listOperators(ctx.db);
  return (
    <>
      <PageHeader title={t("team.title")} intro={t("team.intro")} />
      <Section id="team-list" title={t("team.title")}>
        {!result.ok ? (
          <Empty>{t("common.loadError")}</Empty>
        ) : (
          <Table
            caption={t("team.title")}
            testId="team"
            columns={[t("team.person"), t("team.role"), t("team.granted"), t("common.what")]}
            rows={result.data.map((g) => ({
              key: g.id,
              cells: [
                <span key="person" className="flex flex-col gap-4">
                  <span>{g.fullName ?? t("common.unknownPerson")}</span>
                  {g.email ? (
                    <span className="text-text-12 text-text-secondary">{g.email}</span>
                  ) : null}
                </span>,
                label("roles", g.role),
                <span key="granted" className="flex flex-col gap-4 text-text-12">
                  <span>
                    {g.grantedByName
                      ? t("team.grantedBy", {
                          when: instant(g.grantedAt),
                          name: g.grantedByName,
                          reason: g.reason,
                        })
                      : t("team.grantedByPlatform", {
                          when: instant(g.grantedAt),
                          reason: g.reason,
                        })}
                  </span>
                  {g.revokedAt ? (
                    <span className="text-text-secondary">
                      {t("team.revokedBy", {
                        when: instant(g.revokedAt),
                        name: g.revokedByName ?? t("activity.platform"),
                        reason: g.revokeReason ?? "",
                      })}
                    </span>
                  ) : null}
                </span>,
                g.revokedAt || g.personId === ctx.operator.personId ? (
                  t("common.none")
                ) : (
                  <ActionForm
                    key="revoke"
                    action={revokeOperatorAction}
                    hidden={{ grantId: g.id }}
                    submitLabel={t("team.revoke")}
                    successLabel={t("team.revoked")}
                    variant="danger"
                    label={t("team.revokeFor", { email: g.email ?? "" })}
                  >
                    <ReasonField t={t} id={`revoke-${g.id}`} />
                  </ActionForm>
                ),
              ],
            }))}
          />
        )}
      </Section>
      <Section id="team-add" title={t("team.add")}>
        <Panel>
          <ActionForm
            action={grantOperatorAction}
            submitLabel={t("team.grant")}
            successLabel={t("team.grantedOk")}
            label={t("team.add")}
            testId="grant-operator"
          >
            <Input
              id="grant-email"
              name="email"
              type="email"
              label={t("team.email")}
              help={t("team.emailHelp")}
              required
            />
            <Select
              id="grant-role"
              name="role"
              label={t("team.role")}
              value="Support"
              options={ROLES.map((r) => ({ value: r, label: t(`roles.${r}`) }))}
            />
            <ReasonField t={t} id="grant-reason" />
          </ActionForm>
        </Panel>
      </Section>
    </>
  );
}
