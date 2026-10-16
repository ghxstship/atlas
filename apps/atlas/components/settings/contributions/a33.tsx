import { listMembers, listRoles } from "@xos/data";
import { listCurrencies } from "@xos/data/finance";
import { listApprovalPolicies, listStateLabels } from "@xos/data/workflow";
import { getLocale, getTranslations } from "next-intl/server";
import { InlineAlert } from "@/components/ui";
import {
  AddStepForm,
  CreatePolicyForm,
  DeletePolicyButton,
  PolicyTransition,
  RemoveStepButton,
  StateLabelRow,
} from "@/components/workflow/settings-client";
import { getExponents, moneyFormatter } from "@/lib/finance/money";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A33's settings panels (ADR 0021 item 7):
 *   Settings, Approval policies   the org's approval policies by spend document type, their ordered
 *                                 steps and their Draft, Active and Retired lifecycle
 *   Settings, Views and defaults  display labels for the nine record states
 * The registry setting approvals.requester_may_cancel (packages/schemas/settings/a33.yaml) renders
 * above them on the approval policies page. Each panel reads with the viewer's client, so row level
 * security decides what appears; editing needs org.approval_policies.write or org.views.write.
 */

type T = (key: string, values?: Record<string, string | number>) => string;

function Heading({ id, title, description }: { id: string; title: string; description: string }) {
  return (
    <header className="flex flex-col gap-4">
      <h2 id={id} className="m-0 text-heading-16 font-semibold">
        {title}
      </h2>
      <p className="m-0 text-text-secondary">{description}</p>
    </header>
  );
}

async function ApprovalPoliciesPanel({ ctx }: SettingsPanelProps) {
  const t = (await getTranslations("workflow")) as unknown as T;
  const shell = (await getTranslations("shell")) as unknown as T;
  const db = ctx.viewer.db;
  const org = ctx.org.slug;
  const editable = ctx.capabilities.has("org.approval_policies.write");
  const [policies, roles, members, currencies] = await Promise.all([
    listApprovalPolicies(db, ctx.org.id),
    listRoles(db, ctx.org.id),
    listMembers(db, ctx.org.id),
    listCurrencies(db),
  ]);
  if (!policies.ok || !roles.ok || !members.ok || !currencies.ok) {
    return <InlineAlert tone="danger">{t("policies.loadError")}</InlineAlert>;
  }
  const [locale, exponents] = await Promise.all([getLocale(), getExponents(ctx)]);
  const money = moneyFormatter(locale, exponents, t("common.unpriced"));
  const roleLabel = (id: string) => {
    const role = roles.data.find((r) => r.id === id);
    if (!role) return t("policies.steps.unknownApprover");
    return role.system ? shell(`roles.${role.code}`) : (role.name ?? role.code);
  };
  const memberLabel = (id: string) =>
    members.data.find((m) => m.membershipId === id)?.fullName ??
    t("policies.steps.unknownApprover");
  const approvers = [
    ...roles.data.map((r) => ({
      value: `role:${r.id}`,
      label: t("policies.steps.roleOption", { role: roleLabel(r.id) }),
    })),
    ...members.data.map((m) => ({
      value: `member:${m.membershipId}`,
      label: t("policies.steps.memberOption", { name: m.fullName ?? t("common.someone") }),
    })),
  ];
  return (
    <section aria-labelledby="approval-policies-heading" className="flex flex-col gap-16">
      <Heading
        id="approval-policies-heading"
        title={t("policies.title")}
        description={t("policies.description")}
      />
      {!editable ? <InlineAlert tone="info">{t("policies.readOnly")}</InlineAlert> : null}
      {policies.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {editable ? t("policies.emptyEditor") : t("policies.empty")}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-12 p-0" aria-label={t("policies.listLabel")}>
          {policies.data.map((p) => (
            <li
              key={p.id}
              className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
            >
              <div className="flex flex-wrap items-start justify-between gap-8">
                <div className="flex flex-col gap-2">
                  <h3 className="m-0 text-text-14 font-semibold">{p.name}</h3>
                  <p className="m-0 text-text-12 text-text-secondary">
                    {t("policies.summary", {
                      type: t(`documentTypes.${p.documentType}`),
                      state: t(`policyStates.${p.state}`),
                      scope:
                        p.appliesAboveMinor === null || p.currency === null
                          ? t("policies.everyAmount")
                          : t("policies.above", { amount: money(p.appliesAboveMinor, p.currency) }),
                    })}
                  </p>
                  {p.description ? (
                    <p className="m-0 text-text-12 text-text-secondary">{p.description}</p>
                  ) : null}
                </div>
                {editable ? (
                  <div className="flex flex-wrap gap-6">
                    {p.state === "Draft" ? (
                      <PolicyTransition org={org} policy={p} to="Active" />
                    ) : null}
                    {p.state !== "Retired" ? (
                      <PolicyTransition org={org} policy={p} to="Retired" />
                    ) : null}
                    {p.state !== "Active" ? (
                      <DeletePolicyButton org={org} id={p.id} name={p.name} />
                    ) : null}
                  </div>
                ) : null}
              </div>
              {p.steps.length === 0 ? (
                <p className="m-0 text-text-12 text-text-secondary">{t("policies.steps.none")}</p>
              ) : (
                <ol
                  className="m-0 flex list-none flex-col gap-4 p-0"
                  aria-label={t("policies.steps.label", { name: p.name })}
                >
                  {p.steps.map((s) => (
                    <li
                      key={s.id}
                      className="flex flex-wrap items-center justify-between gap-6 text-text-13"
                    >
                      <span>
                        {t("policies.steps.line", {
                          order: s.order,
                          name: s.name,
                          approver: s.roleId
                            ? roleLabel(s.roleId)
                            : memberLabel(s.membershipId ?? ""),
                        })}
                      </span>
                      {editable && p.state === "Draft" ? (
                        <RemoveStepButton org={org} id={s.id} name={s.name} />
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
              {editable && p.state === "Draft" ? (
                <AddStepForm org={org} policyId={p.id} approvers={approvers} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editable ? (
        <section aria-labelledby="approval-policy-create" className="flex flex-col gap-8">
          <h3 id="approval-policy-create" className="m-0 text-text-14 font-semibold">
            {t("policies.create.title")}
          </h3>
          <CreatePolicyForm
            org={org}
            currencies={currencies.data.map((c) => ({ code: c.code, exponent: c.exponent }))}
          />
        </section>
      ) : null}
    </section>
  );
}

async function StateLabelsPanel({ ctx }: SettingsPanelProps) {
  const t = (await getTranslations("workflow")) as unknown as T;
  const labels = await listStateLabels(ctx.viewer.db, ctx.org.id);
  if (!labels.ok) return <InlineAlert tone="danger">{t("labels.loadError")}</InlineAlert>;
  const editable = ctx.capabilities.has("org.views.write");
  return (
    <section aria-labelledby="state-labels-heading" className="flex flex-col gap-12">
      <Heading
        id="state-labels-heading"
        title={t("labels.title")}
        description={t("labels.description")}
      />
      {!editable ? <InlineAlert tone="info">{t("labels.readOnly")}</InlineAlert> : null}
      <ul className="m-0 flex list-none flex-col gap-8 p-0" aria-label={t("labels.listLabel")}>
        {labels.data.map((row) => (
          <li key={row.state} className="flex flex-col gap-2">
            <StateLabelRow org={ctx.org.slug} row={row} editable={editable} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.approval-policies", order: 10, Panel: ApprovalPoliciesPanel },
  { node: "settings.views-and-defaults", order: 30, Panel: StateLabelsPanel },
];
