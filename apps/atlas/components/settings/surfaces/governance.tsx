import { listMembers, listRoles } from "@xos/data";
import { getAutomationSummary } from "@xos/data/automations";
import { listCanonExtensionProposals } from "@xos/data/canon";
import { listCurrencies } from "@xos/data/finance";
import {
  CUSTOM_DATA_TYPES,
  listCustomFields,
  listCustomFieldTargets,
  listSeparationRules,
  listSpendAuthorities,
  SPEND_DOCUMENT_TYPES,
} from "@xos/data/governance";
import { listSettingValues } from "@xos/data/settings";
import {
  addCustomFieldChoiceAction,
  addSpendLimitAction,
  createCustomFieldAction,
  removeCustomFieldAction,
  removeSpendLimitAction,
} from "@/app/[org]/settings/surface-actions";
import { legalEntityDefaults } from "@/lib/shell/org-settings";
import type { SettingsPanelProps } from "../contributions/types";
import { SurfaceButton, SurfaceForm } from "./forms";
import {
  Chip,
  Code,
  formatters,
  LoadFailed,
  P,
  Quiet,
  Rows,
  Section,
  Subsection,
  TextLink,
  type Formatters,
} from "./kit";

/**
 * Org rule panels (A86, RRR-131, finding A65-004):
 *   Spend Authority        limits per role or member, document type and currency (Section 4.5.6 org item 22)
 *   Separation of Duties   the rules every org is held to (item 23); none can be loosened
 *   Custom Fields          fields on built-in tables and their choices (item 16)
 *   Canon Extensions       the org's proposed and approved extensions, made on the Canon page (item 14)
 *   Automations            what runs on its own today: scheduled reports, recurring work, approval policies
 *                          and webhooks (item 20; rule-based automations are finding A65-010)
 */

function removeConfirm(f: Formatters, key: string, values: Record<string, string>) {
  return {
    title: f.t(`${P}.${key}.title`, values),
    body: f.t(`${P}.${key}.body`, values),
    confirmLabel: f.t(`${P}.${key}.confirm`),
    cancelLabel: f.t(`${P}.cancel`),
  };
}

function documentTypeLabel(f: Formatters, type: string): string {
  return f.t(`${P}.documentTypes.${type.replaceAll(" ", "")}`);
}

// Spend authority ----------------------------------------------------------------------------------------

export async function SpendAuthorityPanel({ ctx }: SettingsPanelProps) {
  const [f, limits, roles, members, currencies, settings] = await Promise.all([
    formatters(ctx),
    listSpendAuthorities(ctx.viewer.db, ctx.org.id),
    listRoles(ctx.viewer.db, ctx.org.id),
    listMembers(ctx.viewer.db, ctx.org.id),
    listCurrencies(ctx.viewer.db),
    listSettingValues(ctx.viewer.db, ctx.org.id),
  ]);
  if (!limits.ok || !roles.ok || !currencies.ok) return <LoadFailed t={f.t} />;
  const memberList = members.ok ? members.data : [];
  const canEdit = ctx.capabilities.has("org.spend_authority.write");
  const roleLabel = (id: string) => {
    const role = roles.data.find((r) => r.id === id);
    if (!role) return f.t(`${P}.someone`);
    return role.system ? f.t(`shell.roles.${role.code}`) : (role.name ?? role.code);
  };
  const holderLabel = (roleId: string | null, membershipId: string | null) =>
    roleId
      ? f.t(`${P}.spend.roleHolder`, { role: roleLabel(roleId) })
      : (memberList.find((m) => m.membershipId === membershipId)?.fullName ?? f.t(`${P}.someone`));
  // A new limit starts in the org's base currency (org.base_currency), as a new legal entity does.
  const base = legalEntityDefaults(
    (key) =>
      (settings.ok ? settings.data : []).find(
        (v) => v.key === key && v.scopeKind === "Organization",
      )?.value,
  ).currency;
  return (
    <Section
      id="spend-authority"
      title={f.t(`${P}.spend.title`)}
      description={f.t(`${P}.spend.description`)}
    >
      {limits.data.length === 0 ? (
        <Quiet>{f.t(`${P}.spend.none`)}</Quiet>
      ) : (
        <Rows
          label={f.t(`${P}.spend.title`)}
          rows={limits.data.map((l) => ({
            id: l.id,
            title: (
              <>
                {holderLabel(l.roleId, l.membershipId)}
                <Chip>{documentTypeLabel(f, l.documentType)}</Chip>
              </>
            ),
            meta: [
              f.t(`${P}.spend.upTo`, { amount: f.money(l.limitMinor, l.currencyCode) }),
              l.dualApprovalAboveMinor !== null
                ? f.t(`${P}.spend.dualAbove`, {
                    amount: f.money(l.dualApprovalAboveMinor, l.currencyCode),
                  })
                : f.t(`${P}.spend.oneApprover`),
              l.validTo ? f.t(`${P}.expiry.until`, { date: f.day(l.validTo) }) : null,
              l.narrowed ? f.t(`${P}.spend.narrowed`) : null,
            ],
            actions: canEdit ? (
              <SurfaceButton
                action={removeSpendLimitAction}
                hidden={{ org: ctx.org.slug, id: l.id }}
                label={f.t(`${P}.remove`)}
                confirm={removeConfirm(f, "spend.removeConfirm", {
                  holder: holderLabel(l.roleId, l.membershipId),
                })}
              />
            ) : undefined,
          }))}
        />
      )}
      <Quiet>{f.t(`${P}.spend.selfGrant`)}</Quiet>
      {canEdit ? (
        <Subsection title={f.t(`${P}.spend.add`)}>
          <SurfaceForm
            id="spend-limit-create"
            action={addSpendLimitAction}
            label={f.t(`${P}.spend.add`)}
            hidden={{ org: ctx.org.slug }}
            submitLabel={f.t(`${P}.spend.addSubmit`)}
            doneLabel={f.t(`${P}.spend.added`)}
            fields={[
              {
                kind: "select",
                name: "holder",
                label: f.t(`${P}.spend.holder`),
                prompt: f.t(`${P}.choose`),
                options: [
                  ...roles.data.map((r) => ({
                    value: `role:${r.id}`,
                    label: f.t(`${P}.spend.roleHolder`, { role: roleLabel(r.id) }),
                  })),
                  ...memberList.map((m) => ({
                    value: `member:${m.membershipId}`,
                    label: m.fullName ?? f.t(`${P}.someone`),
                  })),
                ],
              },
              {
                kind: "select",
                name: "documentType",
                label: f.t(`${P}.spend.documentType`),
                options: SPEND_DOCUMENT_TYPES.map((d) => ({
                  value: d,
                  label: documentTypeLabel(f, d),
                })),
                defaultValue: "Purchase Order",
              },
              {
                kind: "select",
                name: "currency",
                label: f.t(`${P}.spend.currency`),
                options: currencies.data.map((c) => ({ value: c.code, label: c.code })),
                defaultValue: currencies.data.some((c) => c.code === base) ? base : undefined,
              },
              {
                kind: "text",
                name: "limit",
                label: f.t(`${P}.spend.limit`),
                inputMode: "decimal",
                required: true,
              },
              {
                kind: "text",
                name: "dualAbove",
                label: f.t(`${P}.spend.dual`),
                help: f.t(`${P}.spend.dualHelp`),
                inputMode: "decimal",
              },
            ]}
          />
        </Subsection>
      ) : null}
    </Section>
  );
}

// Separation of duties -----------------------------------------------------------------------------------

export async function SeparationOfDutiesPanel({ ctx }: SettingsPanelProps) {
  const [f, rules] = await Promise.all([formatters(ctx), listSeparationRules(ctx.viewer.db)]);
  if (!rules.ok) return <LoadFailed t={f.t} />;
  return (
    <Section id="sod-rules" title={f.t(`${P}.sod.title`)} description={f.t(`${P}.sod.description`)}>
      <Rows
        label={f.t(`${P}.sod.title`)}
        rows={rules.data.map((r) => ({
          id: r.code,
          title: r.description,
          meta: [
            <Code key="c">{r.code}</Code>,
            f.t(`${P}.sod.enforcedOn`, { where: r.enforcedOn }),
          ],
        }))}
      />
      <Quiet>{f.t(`${P}.sod.tighten`)}</Quiet>
    </Section>
  );
}

// Custom fields ------------------------------------------------------------------------------------------

function targetLabel(f: Formatters, table: string): string {
  const key = `${P}.customFields.targets.${table.replace(/^app\./, "")}`;
  return f.t(key);
}

export async function CustomFieldsPanel({ ctx }: SettingsPanelProps) {
  const [f, fields, targets] = await Promise.all([
    formatters(ctx),
    listCustomFields(ctx.viewer.db, ctx.org.id),
    listCustomFieldTargets(ctx.viewer.db),
  ]);
  if (!fields.ok || !targets.ok) return <LoadFailed t={f.t} />;
  const canEdit = ctx.capabilities.has("org.custom_fields.write");
  return (
    <Section
      id="custom-fields"
      title={f.t(`${P}.customFields.title`)}
      description={f.t(`${P}.customFields.description`)}
    >
      {fields.data.length === 0 ? (
        <Quiet>{f.t(`${P}.customFields.none`)}</Quiet>
      ) : (
        <Rows
          label={f.t(`${P}.customFields.title`)}
          rows={fields.data.map((field) => ({
            id: field.id,
            title: (
              <>
                {field.label}
                <Chip>{f.t(`${P}.customFields.types.${field.dataType}`)}</Chip>
                {field.required ? (
                  <Chip tone="warning">{f.t(`${P}.customFields.required`)}</Chip>
                ) : null}
              </>
            ),
            meta: [
              targetLabel(f, field.targetTable),
              <Code key="k">{field.key}</Code>,
              field.filterable ? f.t(`${P}.customFields.filterable`) : null,
              field.dataType === "Choice"
                ? field.choices.length === 0
                  ? f.t(`${P}.customFields.noChoices`)
                  : f.t(`${P}.customFields.choices`, {
                      choices: field.choices.map((c) => c.label).join(", "),
                    })
                : null,
            ],
            actions: canEdit ? (
              <SurfaceButton
                action={removeCustomFieldAction}
                hidden={{ org: ctx.org.slug, id: field.id }}
                label={f.t(`${P}.remove`)}
                confirm={removeConfirm(f, "customFields.removeConfirm", { label: field.label })}
              />
            ) : undefined,
            children:
              canEdit && field.dataType === "Choice" ? (
                <SurfaceForm
                  id={`choice-${field.id}`}
                  action={addCustomFieldChoiceAction}
                  label={f.t(`${P}.customFields.addChoiceFor`, { label: field.label })}
                  hidden={{
                    org: ctx.org.slug,
                    fieldId: field.id,
                    sortOrder: String((field.choices.length + 1) * 10),
                  }}
                  submitLabel={f.t(`${P}.customFields.addChoice`)}
                  fields={[
                    {
                      kind: "text",
                      name: "label",
                      label: f.t(`${P}.customFields.choiceLabel`),
                      maxLength: 100,
                    },
                  ]}
                />
              ) : undefined,
          }))}
        />
      )}
      {canEdit ? (
        <Subsection title={f.t(`${P}.customFields.add`)}>
          <SurfaceForm
            id="custom-field-create"
            action={createCustomFieldAction}
            label={f.t(`${P}.customFields.add`)}
            hidden={{ org: ctx.org.slug, sortOrder: String((fields.data.length + 1) * 10) }}
            submitLabel={f.t(`${P}.customFields.addSubmit`)}
            doneLabel={f.t(`${P}.customFields.added`)}
            fields={[
              {
                kind: "select",
                name: "target",
                label: f.t(`${P}.customFields.target`),
                options: targets.data.map((t) => ({ value: t, label: targetLabel(f, t) })),
                defaultValue: targets.data.includes("app.projects") ? "app.projects" : undefined,
              },
              {
                kind: "text",
                name: "label",
                label: f.t(`${P}.customFields.label`),
                required: true,
                maxLength: 100,
              },
              {
                kind: "text",
                name: "key",
                label: f.t(`${P}.customFields.key`),
                help: f.t(`${P}.customFields.keyHelp`),
                maxLength: 48,
              },
              {
                kind: "select",
                name: "dataType",
                label: f.t(`${P}.customFields.type`),
                help: f.t(`${P}.customFields.typeHelp`),
                options: CUSTOM_DATA_TYPES.map((d) => ({
                  value: d,
                  label: f.t(`${P}.customFields.types.${d}`),
                })),
                defaultValue: "Text",
              },
              { kind: "checkbox", name: "required", label: f.t(`${P}.customFields.requiredLabel`) },
              {
                kind: "checkbox",
                name: "filterable",
                label: f.t(`${P}.customFields.filterableLabel`),
                help: f.t(`${P}.customFields.filterableHelp`),
              },
            ]}
          />
        </Subsection>
      ) : null}
    </Section>
  );
}

// Canon extensions -----------------------------------------------------------------------------------------

export async function CanonExtensionsPanel({ ctx }: SettingsPanelProps) {
  const [f, proposals] = await Promise.all([
    formatters(ctx),
    listCanonExtensionProposals(ctx.viewer.db, ctx.org.id),
  ]);
  if (!proposals.ok) return <LoadFailed t={f.t} />;
  const count = (state: string) => proposals.data.filter((p) => p.state === state).length;
  const shown = proposals.data.filter((p) => p.state === "Approved" || p.state === "Proposed");
  return (
    <Section
      id="canon-extensions"
      title={f.t(`${P}.canon.title`)}
      description={f.t(`${P}.canon.description`)}
    >
      <p role="status" className="m-0 text-text-13">
        {f.t(`${P}.canon.counts`, {
          approved: count("Approved"),
          proposed: count("Proposed"),
          closed: count("Rejected") + count("Withdrawn"),
        })}
      </p>
      {shown.length === 0 ? (
        <Quiet>{f.t(`${P}.canon.none`)}</Quiet>
      ) : (
        <Rows
          label={f.t(`${P}.canon.title`)}
          rows={shown.map((p) => ({
            id: p.id,
            title: (
              <>
                {p.label}
                <Chip tone={p.state === "Approved" ? "success" : "warning"}>
                  {f.t(`${P}.canon.states.${p.state}`)}
                </Chip>
              </>
            ),
            meta: [
              <Code key="c">{p.proposedCode}</Code>,
              f.t(`${P}.canon.under`, { parent: p.parentCode }),
              f.t(`${P}.canon.levels.${p.level}`),
            ],
          }))}
        />
      )}
      <TextLink href={`/${ctx.org.slug}/canon/org-extensions`}>{f.t(`${P}.canon.open`)}</TextLink>
    </Section>
  );
}

// Automations ----------------------------------------------------------------------------------------------

export async function AutomationsPanel({ ctx }: SettingsPanelProps) {
  const [f, summary] = await Promise.all([
    formatters(ctx),
    getAutomationSummary(ctx.viewer.db, ctx.org.id),
  ]);
  if (!summary.ok) return <LoadFailed t={f.t} />;
  const s = summary.data;
  const slug = ctx.org.slug;
  return (
    <>
      <Section
        id="automations-scheduled"
        title={f.t(`${P}.automations.title`)}
        description={f.t(`${P}.automations.description`)}
      >
        <Rows
          label={f.t(`${P}.automations.title`)}
          rows={[
            {
              id: "recurring",
              title: f.t(`${P}.automations.recurring`, { count: s.recurringRecords }),
              meta: [f.t(`${P}.automations.recurringHelp`)],
              actions: (
                <TextLink href={`/${slug}/work/recurring`}>
                  {f.t(`${P}.automations.manage`)}
                </TextLink>
              ),
            },
            {
              id: "policies",
              title: f.t(`${P}.automations.policies`, { count: s.activeApprovalPolicies }),
              meta: [f.t(`${P}.automations.policiesHelp`)],
              actions: (
                <TextLink href={`/${slug}/settings/approval-policies`}>
                  {f.t(`${P}.automations.manage`)}
                </TextLink>
              ),
            },
            {
              id: "webhooks",
              title: f.t(`${P}.automations.webhooks`, { count: s.liveWebhooks }),
              meta: [f.t(`${P}.automations.webhooksHelp`)],
              actions: (
                <TextLink href={`/${slug}/settings/webhooks`}>
                  {f.t(`${P}.automations.manage`)}
                </TextLink>
              ),
            },
          ]}
        />
      </Section>
      <Section
        id="automations-reports"
        title={f.t(`${P}.automations.reportsTitle`)}
        description={f.t(`${P}.automations.reportsDescription`)}
      >
        {s.scheduledReports.length === 0 ? (
          <Quiet>{f.t(`${P}.automations.noReports`)}</Quiet>
        ) : (
          <Rows
            label={f.t(`${P}.automations.reportsTitle`)}
            rows={s.scheduledReports.map((r) => ({
              id: r.id,
              title: (
                <>
                  {r.reportName || f.t(`${P}.automations.untitled`)}
                  {r.paused ? <Chip tone="warning">{f.t(`${P}.webhooks.paused`)}</Chip> : null}
                </>
              ),
              meta: [
                f.t(`${P}.automations.cadence.${r.cadence}`),
                r.paused ? null : f.t(`${P}.automations.nextRun`, { date: f.when(r.nextRunAt) }),
              ],
            }))}
          />
        )}
        <TextLink href={`/${slug}/reports`}>{f.t(`${P}.automations.openReports`)}</TextLink>
      </Section>
    </>
  );
}
