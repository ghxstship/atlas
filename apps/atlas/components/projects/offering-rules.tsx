import type { XosClient } from "@xos/data";
import {
  listOfferingRules,
  OFFERING_KINDS,
  OFFERING_MODES,
  type ExternalRoleType,
  type OfferingRule,
} from "@xos/data/offerings";
import { listVendorClasses } from "@xos/data/vendors";
import dynamic from "next/dynamic";
import { InlineAlert } from "@/components/ui";
import type { Translate } from "@/lib/shell/translate";
import type { OfferingRuleCopy, OfferingRuleScope } from "./offering-rule-form";

/**
 * The audience rules of the org's offerings (R3, owner decision 7), for the whole org (Settings,
 * Gateway and marketplace) or one project (Project Settings, Offerings): a table of the live rules
 * and, for people with projects.settings.write, the add form and Remove. The controls load on
 * demand, so the settings pages carry no rule code until a person can use it. Reads with the
 * viewer's client, so row level security decides what appears.
 */

const OfferingRuleForm = dynamic(() =>
  import("./offering-rule-form").then((m) => m.OfferingRuleForm),
);
const RemoveOfferingRule = dynamic(() =>
  import("./offering-rule-form").then((m) => m.RemoveOfferingRule),
);

const O = "projects.settings.offerings";

const ROLE_TYPES: readonly ExternalRoleType[] = [
  "Client",
  "Vendor",
  "Contractor",
  "Crew",
  "Staff",
  "Artist",
  "Artist Representative",
  "Sponsor",
];

const ERROR_KEYS = ["conflict", "invalid", "crossOrg", "notFound", "unexpected"] as const;

function ruleLabel(t: Translate, rule: OfferingRule): string {
  return [
    t(`${O}.kinds.${rule.offering}`),
    rule.roleType ? t(`people.roleTypes.${rule.roleType}`) : t(`${O}.everyRoleType`),
    rule.vendorClassName ?? t(`${O}.everyVendorClass`),
  ].join(", ");
}

export async function OfferingRules({
  t,
  db,
  orgId,
  scope,
  canEdit,
  headingId,
}: {
  t: Translate;
  db: XosClient;
  orgId: string;
  scope: OfferingRuleScope;
  canEdit: boolean;
  headingId: string;
}) {
  const [rules, classes] = await Promise.all([
    listOfferingRules(db, { orgId, projectId: scope.projectId === "" ? null : scope.projectId }),
    canEdit ? listVendorClasses(db, orgId) : Promise.resolve(null),
  ]);
  if (!rules.ok) return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  const errors = Object.fromEntries(ERROR_KEYS.map((k) => [k, t(`${O}.errors.${k}`)]));
  const copy: OfferingRuleCopy = {
    offering: t(`${O}.offering`),
    roleType: t(`${O}.roleType`),
    vendorClass: t(`${O}.vendorClass`),
    mode: t(`${O}.mode`),
    capPerEngagement: t(`${O}.capPerEngagement`),
    capPerPerson: t(`${O}.capPerPerson`),
    capHelp: t(`${O}.capHelp`),
    addRule: t(`${O}.addRule`),
    added: t(`${O}.added`),
    remove: t(`${O}.remove`),
    errors,
  };
  const cap = (value: number | null) => (value === null ? t(`${O}.noCap`) : String(value));
  return (
    <div className="flex flex-col gap-12" data-testid="offering-rules">
      {rules.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${O}.empty`)}</p>
      ) : (
        // A labelled, focusable region, so keyboard users can scroll the table sideways.
        <div role="region" aria-labelledby={headingId} tabIndex={0} className="overflow-x-auto">
          <table className="w-full border-collapse text-text-13">
            <thead>
              <tr className="text-text-12 text-text-secondary">
                <th scope="col" className="py-6 pe-12 text-start font-medium">
                  {copy.offering}
                </th>
                <th scope="col" className="py-6 pe-12 text-start font-medium">
                  {copy.roleType}
                </th>
                <th scope="col" className="py-6 pe-12 text-start font-medium">
                  {copy.vendorClass}
                </th>
                <th scope="col" className="py-6 pe-12 text-start font-medium">
                  {copy.mode}
                </th>
                <th scope="col" className="py-6 pe-12 text-end font-medium">
                  {copy.capPerEngagement}
                </th>
                <th scope="col" className="py-6 pe-12 text-end font-medium">
                  {copy.capPerPerson}
                </th>
                {canEdit ? (
                  <th scope="col" className="py-6 text-end font-medium">
                    <span className="sr-only">{t(`${O}.actions`)}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rules.data.map((rule) => (
                <tr key={rule.id} className="border-t border-border-subtle">
                  <th scope="row" className="py-6 pe-12 text-start font-medium">
                    {t(`${O}.kinds.${rule.offering}`)}
                  </th>
                  <td className="py-6 pe-12">
                    {rule.roleType
                      ? t(`people.roleTypes.${rule.roleType}`)
                      : t(`${O}.everyRoleType`)}
                  </td>
                  <td className="py-6 pe-12">
                    {rule.vendorClassName ?? t(`${O}.everyVendorClass`)}
                  </td>
                  <td className="py-6 pe-12">{t(`${O}.modes.${rule.mode}`)}</td>
                  <td className="py-6 pe-12 text-end tabular-nums">{cap(rule.capPerEngagement)}</td>
                  <td className="py-6 pe-12 text-end tabular-nums">{cap(rule.capPerPerson)}</td>
                  {canEdit ? (
                    <td className="py-6 text-end">
                      <RemoveOfferingRule
                        scope={scope}
                        ruleId={rule.id}
                        label={copy.remove}
                        accessibleName={`${copy.remove}: ${ruleLabel(t, rule)}`}
                        errors={errors}
                      />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canEdit ? (
        <OfferingRuleForm
          scope={scope}
          copy={copy}
          offerings={OFFERING_KINDS.map((k) => ({ value: k, label: t(`${O}.kinds.${k}`) }))}
          roleTypes={[
            { value: "", label: t(`${O}.everyRoleType`) },
            ...ROLE_TYPES.map((r) => ({ value: r, label: t(`people.roleTypes.${r}`) })),
          ]}
          vendorClasses={[
            { value: "", label: t(`${O}.everyVendorClass`) },
            ...(classes?.ok ? classes.data.map((c) => ({ value: c.id, label: c.name })) : []),
          ]}
          modes={OFFERING_MODES.map((m) => ({ value: m, label: t(`${O}.modes.${m}`) }))}
        />
      ) : (
        <p className="m-0 text-text-12 text-text-secondary">{t(`${O}.readOnly`)}</p>
      )}
    </div>
  );
}
