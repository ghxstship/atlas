import { listMembers, listRoles } from "@xos/data";
import { listAssetClasses } from "@xos/data/assets";
import { listCredentialCategories } from "@xos/data/credentials";
import { listEngagements } from "@xos/data/opportunities";
import { listZones } from "@xos/data/places";
import { listApprovalRules, type ApprovalRule, type ApprovalRuleStep } from "@xos/data/workflow";
import dynamic from "next/dynamic";
import { ToneChip } from "@/components/operations/kit";
import { InlineAlert } from "@/components/ui";
import type { ProjectContext } from "@/lib/projects/context";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import type { Choice, FilterChoices } from "./project-approval-rule-editor";

/**
 * Project Settings, Approval rules (P9, gap G-31, migration 2860): who approves a pass, a dock
 * booking or an equipment request on this project before it takes effect, in ordered steps. A step
 * names a role, a member or an engagement of the project; an engagement step may let its approver
 * decide from the email without signing in, with a 6-digit code emailed when they press the link
 * (2861). Shown to holders of projects.settings.write or org.approval_policies.write, the
 * capabilities the rule policies check again. The editor loads on demand.
 */

const editor = () => import("./project-approval-rule-editor");
const NewApprovalRuleForm = dynamic(() => editor().then((m) => m.NewApprovalRuleForm));
const AddApprovalRuleStepForm = dynamic(() => editor().then((m) => m.AddApprovalRuleStepForm));
const RemoveApprovalRuleStep = dynamic(() => editor().then((m) => m.RemoveApprovalRuleStep));
const ApprovalRuleTransition = dynamic(() => editor().then((m) => m.ApprovalRuleTransition));
const DeleteApprovalRule = dynamic(() => editor().then((m) => m.DeleteApprovalRule));

const R = "projects.settings.approvalRules";

/** Engagements an approver step may name: live ones (not Complete or Canceled). */
const LIVE_ENGAGEMENTS = ["Onboarding", "Blocked", "Active", "Closing"] as const;

const STATE_TONE = { Draft: "neutral", Active: "success", Retired: "neutral" } as const;

export async function ProjectApprovalRules({ ctx }: { ctx: ProjectContext }) {
  const canEdit =
    ctx.capabilities.has("projects.settings.write") ||
    ctx.org.capabilities.has("org.approval_policies.write");
  if (!canEdit) return null;
  const t = await getTranslate();
  const db = ctx.org.viewer.db;
  const orgId = ctx.org.org.id;
  const [rules, categories, zones, classes, roles, members, engagements] = await Promise.all([
    listApprovalRules(db, ctx.project.id),
    listCredentialCategories(db, { orgId, projectId: ctx.project.id }),
    listZones(db, { orgId }),
    listAssetClasses(db, orgId),
    listRoles(db, orgId),
    listMembers(db, orgId),
    listEngagements(db, orgId, { projectId: ctx.project.id, states: LIVE_ENGAGEMENTS }),
  ]);
  if (!rules.ok) return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  // A list the viewer may not read (members need org.members.read) leaves its choices out, never the section.
  const filters: FilterChoices = {
    Pass: categories.ok
      ? categories.data.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` }))
      : [],
    Delivery: zones.ok
      ? zones.data.map((z) => ({ value: z.id, label: `${z.code} ${z.name}` }))
      : [],
    Equipment: classes.ok ? classes.data.map((c) => ({ value: c.id, label: c.name })) : [],
  };
  const roleChoices: Choice[] = roles.ok
    ? roles.data.map((r) => ({
        value: `role:${r.id}`,
        label: t(`${R}.approverKinds.role`, { name: r.name ?? t(`shell.roles.${r.code}`) }),
      }))
    : [];
  const memberChoices: Choice[] = members.ok
    ? members.data.map((m) => ({
        value: `member:${m.membershipId}`,
        label: t(`${R}.approverKinds.member`, { name: m.fullName ?? m.membershipId }),
      }))
    : [];
  const engagementChoices: Choice[] = engagements.ok
    ? engagements.data.map((e) => ({
        value: `engagement:${e.id}`,
        label: t(`${R}.approverKinds.engagement`, {
          name: e.partyName ?? e.accountName ?? e.id,
          role: t(`people.roleTypes.${e.roleType}`),
        }),
      }))
    : [];
  const approvers = [...roleChoices, ...memberChoices, ...engagementChoices];
  const labelOf = new Map(approvers.map((a) => [a.value, a.label]));
  const filterLabel = new Map(
    Object.values(filters).flatMap((list) => list.map((c) => [c.value, c.label] as const)),
  );
  const scope = { org: ctx.org.org.slug, projectId: ctx.project.id, projectKey: ctx.project.key };

  return (
    <section
      aria-labelledby="project-approval-rules"
      className="flex max-w-layout-form flex-col gap-12"
      data-testid="project-approval-rules"
    >
      <header className="flex flex-col gap-4">
        <h2 id="project-approval-rules" className="m-0 text-heading-16 font-semibold">
          {t(`${R}.title`)}
        </h2>
        <p className="m-0 text-text-13 text-text-secondary">{t(`${R}.description`)}</p>
      </header>
      {rules.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${R}.empty`)}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-12 p-0" aria-label={t(`${R}.title`)}>
          {rules.data.map((rule) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              t={t}
              scope={scope}
              approvers={approvers}
              approverLabel={(s) => stepApproverLabel(t, s, labelOf)}
              filter={
                rule.filterId
                  ? (filterLabel.get(rule.filterId) ?? t(`${R}.filterGone`))
                  : t(`${R}.fields.every.${rule.subject}`)
              }
            />
          ))}
        </ul>
      )}
      <h3 className="m-0 text-heading-14 font-semibold">{t(`${R}.create.title`)}</h3>
      <NewApprovalRuleForm scope={scope} filters={filters} />
    </section>
  );
}

function stepApproverLabel(
  t: Translate,
  step: ApprovalRuleStep,
  labelOf: ReadonlyMap<string, string>,
): string {
  const key = step.roleId
    ? `role:${step.roleId}`
    : step.membershipId
      ? `member:${step.membershipId}`
      : `engagement:${step.engagementId ?? ""}`;
  return labelOf.get(key) ?? t(`${R}.approverGone`);
}

function RuleCard({
  rule,
  t,
  scope,
  approvers,
  approverLabel,
  filter,
}: {
  rule: ApprovalRule;
  t: Translate;
  scope: { org: string; projectId: string; projectKey: string };
  approvers: readonly Choice[];
  approverLabel: (step: ApprovalRuleStep) => string;
  filter: string;
}) {
  const draft = rule.state === "Draft";
  return (
    <li
      className="flex flex-col gap-12 rounded-card border border-border-subtle p-16"
      data-testid="approval-rule"
    >
      <div className="flex flex-wrap items-start justify-between gap-8">
        <div className="flex min-w-0 flex-col gap-4">
          <h4 className="m-0 text-text-15 font-semibold">{rule.name}</h4>
          <p className="m-0 text-text-13 text-text-secondary">
            {t(`${R}.meta`, { subject: t(`${R}.subjects.${rule.subject}`), filter })}
          </p>
          {rule.description ? (
            <p className="m-0 text-text-12 text-text-secondary">{rule.description}</p>
          ) : null}
        </div>
        <ToneChip tone={STATE_TONE[rule.state]}>
          {t(`workflow.policyStates.${rule.state}`)}
        </ToneChip>
      </div>
      {rule.steps.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${R}.steps.none`)}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-6 p-0" aria-label={t(`${R}.steps.label`)}>
          {rule.steps.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-8 text-text-13">
              <span className="font-medium">
                {t(`${R}.steps.stepName`, { order: s.order, name: s.name })}
              </span>
              <span className="text-text-secondary">{approverLabel(s)}</span>
              {s.signedOutLinks ? (
                <ToneChip tone="accent">{t(`${R}.steps.fromEmail`)}</ToneChip>
              ) : null}
              {draft ? <RemoveApprovalRuleStep scope={scope} id={s.id} name={s.name} /> : null}
            </li>
          ))}
        </ol>
      )}
      {draft && rule.steps.length < 5 && approvers.length > 0 ? (
        <AddApprovalRuleStepForm scope={scope} ruleId={rule.id} approvers={approvers} />
      ) : null}
      <div className="flex flex-wrap items-center gap-8">
        {draft ? <ApprovalRuleTransition scope={scope} rule={rule} to="Active" /> : null}
        {rule.state === "Active" ? (
          <ApprovalRuleTransition scope={scope} rule={rule} to="Retired" />
        ) : null}
        {rule.state !== "Active" ? (
          <DeleteApprovalRule scope={scope} id={rule.id} name={rule.name} />
        ) : null}
      </div>
    </li>
  );
}
