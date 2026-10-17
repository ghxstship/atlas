import { listProjects } from "@xos/data/finance";
import {
  canDecide,
  listApprovalPolicies,
  listApprovals,
  listDocumentsAwaitingApproval,
  type Approval,
  type ApprovalPolicy,
} from "@xos/data/workflow";
import { getNode } from "@xos/ia";
import type { Route } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { PageHeader, StateChip, TemplateCollection } from "@/components/finance/ui";
import { InlineAlert } from "@/components/ui";
import { getExponents, moneyFormatter } from "@/lib/finance/money";
import type { OrgContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";
import { CancelForm, DecisionForm, SubmitForm } from "./approvals-client";
import { EmptyPanel, ErrorPanel, PageStatus } from "./kit";

/**
 * Approvals (Section 4.10 workflow engine, A33): spend documents going through their org's approval
 * policies. Three tabs: what waits on the viewer, what they requested, and (for policy
 * administrators) everything. Each approval shows its document, amount, project, the step it waits
 * on and every decision so far; eligible approvers decide from here and requesters withdraw. A form
 * submits any document an Active policy gates. Row level security decides what appears.
 */

type Tab = "waiting" | "mine" | "all";

const CHIP: Record<Approval["state"], "in-review" | "complete" | "canceled" | "blocked"> = {
  "In Review": "in-review",
  Approved: "complete",
  Rejected: "blocked",
  Canceled: "canceled",
};

export async function ApprovalsView({
  ctx,
  tab: requested,
}: {
  ctx: OrgContext;
  tab: string | null;
}) {
  const t = (await getTranslations("workflow")) as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;
  const org = ctx.org.slug;
  const title = t("approvals.title");
  const admin = ctx.capabilities.has("org.approval_policies.write");
  const tab: Tab = requested === "mine" || (requested === "all" && admin) ? requested : "waiting";
  const db = ctx.viewer.db;
  const [policies, approvals, projects] = await Promise.all([
    listApprovalPolicies(db, ctx.org.id),
    listApprovals(db, ctx.org.id),
    listProjects(db, ctx.org.id),
  ]);
  if (!policies.ok || !approvals.ok || !projects.ok) {
    return (
      <TemplateCollection header={<PageHeader title={title} />}>
        <ErrorPanel sentence={t("approvals.loadError")} />
      </TemplateCollection>
    );
  }
  const active = policies.data.filter((p) => p.state === "Active");
  const documents = await listDocumentsAwaitingApproval(db, {
    orgId: ctx.org.id,
    types: active.map((p) => p.documentType),
  });
  const [locale, exponents] = await Promise.all([getLocale(), getExponents(ctx)]);
  const money = moneyFormatter(locale, exponents, t("common.unpriced"));
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso),
    );
  const projectKey = new Map(projects.data.map((p) => [p.id, p.key]));
  const policyOf = new Map<string, ApprovalPolicy>(policies.data.map((p) => [p.id, p]));
  const personId = ctx.viewer.person?.id ?? "";
  const viewer = {
    personId,
    membershipId: ctx.org.membershipId,
    roleIds: ctx.org.roles.map((r) => r.id),
  };
  const waiting = approvals.data.filter((a) => canDecide(a, policyOf.get(a.policyId), viewer));
  const mine = approvals.data.filter((a) => a.requestedBy === personId);
  const shown = tab === "waiting" ? waiting : tab === "mine" ? mine : approvals.data;
  const open = new Set(
    approvals.data
      .filter((a) => a.state === "In Review" || a.state === "Approved")
      .map((a) => a.documentId),
  );
  const submittable = documents.ok ? documents.data.filter((d) => !open.has(d.id)) : [];
  const tabs: { value: Tab; label: string; count: number }[] = [
    { value: "waiting", label: t("approvals.tabs.waiting"), count: waiting.length },
    { value: "mine", label: t("approvals.tabs.mine"), count: mine.length },
    ...(admin
      ? [{ value: "all" as const, label: t("approvals.tabs.all"), count: approvals.data.length }]
      : []),
  ];
  const settingsRoute = (getNode(sitemap, "settings.approval-policies").node.route ?? "").replace(
    "{org}",
    org,
  );

  return (
    <TemplateCollection
      header={<PageHeader title={title} count={shown.length} />}
      filters={
        <nav aria-label={t("approvals.tabs.label")} className="flex flex-wrap gap-4">
          {tabs.map((x) => (
            <Link
              key={x.value}
              href={`/${org}/approvals?tab=${x.value}` as Route}
              aria-current={x.value === tab ? "page" : undefined}
              className={`inline-flex h-control-md items-center gap-6 rounded-control px-12 text-text-13 font-medium ${
                x.value === tab
                  ? "bg-bg-selected text-text-primary"
                  : "text-text-secondary hover:bg-bg-hover"
              }`}
            >
              {x.label}
              <span className="text-text-tertiary">{x.count}</span>
            </Link>
          ))}
        </nav>
      }
    >
      <PageStatus>
        <div className="flex flex-col gap-24">
          {active.length === 0 ? (
            <InlineAlert tone="info" title={t("approvals.noPolicy.title")}>
              {admin ? (
                <>
                  {t("approvals.noPolicy.admin")}{" "}
                  <Link
                    href={settingsRoute as Route}
                    className="font-medium text-accent-text underline"
                  >
                    {t("approvals.noPolicy.link")}
                  </Link>
                </>
              ) : (
                t("approvals.noPolicy.member")
              )}
            </InlineAlert>
          ) : null}

          {shown.length === 0 ? (
            <EmptyPanel
              icon="CheckCircle2"
              sentence={t(`approvals.empty.${tab}`)}
              actionLabel={t(
                tab === "waiting" ? "approvals.empty.waitingAction" : "approvals.empty.otherAction",
              )}
              href={
                tab === "waiting" ? `/${org}/approvals?tab=mine` : `/${org}/approvals?tab=waiting`
              }
            />
          ) : (
            <ul
              className="m-0 flex list-none flex-col gap-12 p-0"
              aria-label={t("approvals.listLabel")}
            >
              {shown.map((a) => {
                const policy = policyOf.get(a.policyId);
                const steps = policy?.steps ?? [];
                const step = steps.find((s) => s.order === a.currentStep);
                const decidable = canDecide(a, policy, viewer);
                const withdrawable =
                  (a.state === "In Review" || a.state === "Approved") &&
                  (a.requestedBy === personId || admin);
                return (
                  <li
                    key={a.id}
                    className="flex flex-col gap-12 rounded-card border border-border-subtle p-16"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-8">
                      <div className="flex min-w-0 flex-col gap-4">
                        <h2 className="m-0 text-text-15 font-semibold">
                          {t(`documentTypes.${a.documentType}`)}
                          {a.subjectReference ? ` ${a.subjectReference}` : ""}
                        </h2>
                        <p className="m-0 text-text-13 text-text-secondary">
                          {t("approvals.meta", {
                            amount: money(a.amountMinor, a.currency),
                            project: a.projectId
                              ? (projectKey.get(a.projectId) ?? t("common.otherProject"))
                              : t("common.orgWide"),
                            requester: a.requesterName ?? t("common.someone"),
                            when: when(a.createdAt),
                          })}
                        </p>
                        <p className="m-0 text-text-12 text-text-tertiary">
                          {t("approvals.policy", { policy: a.policyName })}
                        </p>
                      </div>
                      <StateChip state={CHIP[a.state]} label={t(`approvalStates.${a.state}`)} />
                    </div>
                    <ol
                      className="m-0 flex list-none flex-col gap-6 p-0"
                      aria-label={t("approvals.stepsLabel")}
                    >
                      {steps.map((s) => {
                        const decision = a.decisions.find((d) => d.step === s.order);
                        const status = decision
                          ? decision.approved
                            ? t("approvals.stepApproved", {
                                name: decision.approverName ?? t("common.someone"),
                                when: when(decision.decidedAt),
                              })
                            : t("approvals.stepRejected", {
                                name: decision.approverName ?? t("common.someone"),
                                when: when(decision.decidedAt),
                              })
                          : a.state === "In Review" && s.order === a.currentStep
                            ? t("approvals.stepWaiting")
                            : t("approvals.stepPending");
                        return (
                          <li key={s.id} className="flex flex-col gap-2 text-text-13">
                            <span>
                              <span className="font-medium">
                                {t("approvals.stepName", { order: s.order, name: s.name })}
                              </span>{" "}
                              <span className="text-text-secondary">{status}</span>
                            </span>
                            {decision?.comment ? (
                              <span className="text-text-12 text-text-secondary">
                                {decision.comment}
                              </span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ol>
                    {decidable ? (
                      <section
                        aria-label={t("approvals.decide.label")}
                        className="flex flex-col gap-8"
                      >
                        <p className="m-0 text-text-12 text-text-secondary">
                          {t("approvals.decide.youDecide", { step: step?.name ?? "" })}
                        </p>
                        <DecisionForm org={org} id={a.id} />
                      </section>
                    ) : null}
                    {withdrawable ? <CancelForm org={org} id={a.id} /> : null}
                  </li>
                );
              })}
            </ul>
          )}

          {active.length > 0 ? (
            <section aria-labelledby="approvals-submit" className="flex flex-col gap-8">
              <h2 id="approvals-submit" className="m-0 text-heading-16 font-semibold">
                {t("approvals.submit.title")}
              </h2>
              <p className="m-0 max-w-layout-reading text-text-13 text-text-secondary">
                {t("approvals.submit.sentence", {
                  types: active.map((p) => t(`documentTypes.${p.documentType}`)).join(", "),
                })}
              </p>
              {!documents.ok ? (
                <InlineAlert tone="danger">{t("approvals.submit.loadError")}</InlineAlert>
              ) : submittable.length === 0 ? (
                <p className="m-0 text-text-13 text-text-secondary">{t("approvals.submit.none")}</p>
              ) : (
                <SubmitForm
                  org={org}
                  documents={submittable.map((d) => ({
                    value: `${d.documentType}|${d.id}`,
                    label: `${t(`documentTypes.${d.documentType}`)}: ${d.reference}${
                      d.projectId && projectKey.get(d.projectId)
                        ? ` (${projectKey.get(d.projectId)})`
                        : ""
                    }`,
                  }))}
                />
              )}
            </section>
          ) : null}
        </div>
      </PageStatus>
    </TemplateCollection>
  );
}
