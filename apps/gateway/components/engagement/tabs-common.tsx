import {
  APP_ENUMS,
  listEngagementDocuments,
  listMessages,
  listOnboardingItems,
  listThreads,
  onboardingStanding,
  readView,
  type EngagementDocumentKind,
} from "@xos/data/gateway";
import { ActionButton } from "@/components/actions/action-button";
import { RegionError, Section } from "@/components/page/page";
import {
  Card,
  EngagementTimeline,
  InlineAlert,
  ProgressBar,
  PropertyList,
  Tag,
} from "@/components/ui";
import { PaymentSteps } from "./payment-steps";
import { signDocumentAction, submitOnboardingItemAction } from "@/lib/actions/engagement";
import { agreeSelfBillingAction, revokeSelfBillingAction } from "@/lib/actions/operations";
import { hasArea, tabHref } from "@/lib/engagement";
import {
  formatDate,
  formatDateRange,
  formatDateTime,
  formatMoney,
  isoDaysFromToday,
  todayIso,
} from "@/lib/format";
import { enumLabelKey } from "@/lib/shell/translate";
import { toneFor } from "@/lib/states";
import {
  InvoiceForm,
  MessageComposer,
  NewThreadForm,
  OnboardingUploadForm,
  RatingForm,
  TaxFormForm,
} from "./forms";
import { RowList, TabEmpty } from "./rows";
import type { TabProps } from "./tab-context";

/** Engagement stages (Section 4.4.4) and where an engagement state sits among them. */
const STAGE_KEYS = ["offer", "onboarding", "engaged", "closeOut"] as const;
const STAGE_FOR_STATE: Record<string, number> = {
  Onboarding: 1,
  Blocked: 1,
  Active: 2,
  Closing: 3,
  Complete: 4,
  Canceled: 4,
};

export async function OverviewTab({ view, t, locale, engagementKey }: TabProps) {
  const e = view.engagement;
  const [documents, onboarding, given] = await Promise.all([
    hasArea(view, "documents") ? listEngagementDocuments(view.ctx.db, e.id) : null,
    hasArea(view, "onboarding") ? listOnboardingItems(view.ctx.db, e.id) : null,
    readView(view.ctx.db, "my_given_ratings", { eq: { engagement_id: e.id } }),
  ]);
  const toSign = documents?.ok ? documents.data.filter((d) => d.state === "Sent") : [];
  const today = todayIso();
  const open = onboarding?.ok
    ? onboarding.data.filter((i) => onboardingStanding(i, today) !== "verified")
    : [];
  const rated = given.ok && given.data.length > 0;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_var(--layout-property-column)] gap-24 max-lg:grid-cols-[minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-16">
        {e.state === "Blocked" ? (
          <InlineAlert tone="warning">{t("gateway.engagement.overview.blocked")}</InlineAlert>
        ) : null}
        {toSign.length > 0 || open.length > 0 ? (
          <Section title={t("gateway.engagement.overview.next")}>
            <RowList
              label={t("gateway.engagement.overview.next")}
              items={[
                ...toSign.map((d) => ({
                  id: d.id,
                  title: t("gateway.home.needsYou.sign", { title: d.title }),
                  meta: [t(enumLabelKey("engagementDocumentKind", d.kind))],
                  action: (
                    <ActionButton
                      action={signDocumentAction.bind(null, d.id)}
                      label={t("gateway.common.sign")}
                      variant="primary"
                      done={t("gateway.common.signed")}
                    />
                  ),
                })),
                ...(open.length > 0
                  ? [
                      {
                        id: "onboarding",
                        title: t("gateway.home.needsYou.onboarding", {
                          n: open.length,
                          org: e.orgName,
                        }),
                        meta: [
                          t("gateway.home.needsYou.onboardingBlocking", {
                            n: open.filter((i) => i.blocking).length,
                          }),
                        ],
                        href: tabHref(
                          engagementKey,
                          view.tabs.includes("engagement.onboarding")
                            ? "engagement.onboarding"
                            : "engagement.overview",
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </Section>
        ) : null}
        <Section title={t("gateway.engagement.overview.stages")}>
          <EngagementTimeline
            current={STAGE_FOR_STATE[e.state] ?? 0}
            stages={STAGE_KEYS.map((k) => ({ label: t(`gateway.engagement.overview.stage.${k}`) }))}
          />
        </Section>
        {e.state === "Complete" ? (
          <Section title={t("gateway.engagement.forms.rating.title", { org: e.orgName })}>
            {rated ? (
              <InlineAlert tone="success">{t("gateway.engagement.overview.rated")}</InlineAlert>
            ) : (
              <RatingForm engagementId={e.id} org={e.orgName} />
            )}
          </Section>
        ) : null}
      </div>
      <aside>
        <Card>
          <PropertyList
            items={[
              { label: t("gateway.work.engagements.org"), value: e.orgName },
              { label: t("gateway.work.engagements.project"), value: e.projectName },
              { label: t("gateway.work.engagements.role"), value: e.jobTitle },
              {
                label: t("gateway.work.engagements.dates"),
                value: formatDateRange(locale, e.startDate, e.endDate),
              },
              {
                label: t("gateway.engagement.overview.rate"),
                value: hasArea(view, "money")
                  ? (formatMoney(locale, e.rateMinor, e.rateCurrency) ??
                    t("gateway.common.unpriced"))
                  : t("gateway.engagement.overview.rateHidden"),
              },
              { label: t("gateway.engagement.overview.payBasis"), value: e.payBasis },
            ]}
          />
        </Card>
      </aside>
    </div>
  );
}

const OFFER_KINDS: readonly EngagementDocumentKind[] = [
  "Offer",
  "Agreement",
  "Statement of Work",
  "Non-Disclosure Agreement",
];

/** Documents, optionally narrowed to some kinds, with Sign where the party signs next. */
export async function DocumentsTab({
  view,
  t,
  locale,
  engagementKey,
  kinds,
}: TabProps & { kinds?: readonly EngagementDocumentKind[] }) {
  const docs = await listEngagementDocuments(view.ctx.db, view.engagement.id);
  if (!docs.ok) return <RegionError />;
  const shown = kinds ? docs.data.filter((d) => kinds.includes(d.kind)) : docs.data;
  if (shown.length === 0) {
    return (
      <TabEmpty
        icon="FileText"
        sentence={t(
          kinds ? "gateway.engagement.documents.emptyKind" : "gateway.engagement.documents.empty",
        )}
        actionLabel={t("gateway.engagement.messagesAction")}
        href={tabHref(engagementKey, "engagement.messages")}
      />
    );
  }
  return (
    <RowList
      label={t("nav.gateway.engagementTabs.documents")}
      items={shown.map((d) => ({
        id: d.id,
        title: d.title,
        meta: [
          t(enumLabelKey("engagementDocumentKind", d.kind)),
          d.expiresOn
            ? t("gateway.engagement.documents.expires", { date: formatDate(locale, d.expiresOn) })
            : null,
        ],
        tag: { label: t(enumLabelKey("engagementDocumentState", d.state)), tone: toneFor(d.state) },
        ...(d.state === "Sent"
          ? {
              action: (
                <ActionButton
                  action={signDocumentAction.bind(null, d.id)}
                  label={t("gateway.common.sign")}
                  variant="primary"
                  done={t("gateway.common.signed")}
                />
              ),
            }
          : {}),
      }))}
    />
  );
}

export function OfferTab(props: TabProps) {
  return <DocumentsTab {...props} kinds={OFFER_KINDS} />;
}

/** The onboarding checklist (Section 11.12 Onboard): progress, each item and how to complete it. */
export async function OnboardingTab({ view, t, locale, engagementKey }: TabProps) {
  const items = await listOnboardingItems(view.ctx.db, view.engagement.id);
  if (!items.ok) return <RegionError />;
  if (items.data.length === 0) {
    return (
      <TabEmpty
        icon="ListChecks"
        sentence={t("gateway.engagement.onboarding.empty")}
        actionLabel={t("gateway.engagement.messagesAction")}
        href={tabHref(engagementKey, "engagement.messages")}
      />
    );
  }
  const today = todayIso();
  const done = items.data.filter((i) => onboardingStanding(i, today) === "verified").length;
  return (
    <div className="flex flex-col gap-16">
      <ProgressBar
        label={t("gateway.engagement.onboarding.progress", { n: done, total: items.data.length })}
        value={(done / items.data.length) * 100}
      />
      <RowList
        label={t("nav.gateway.engagementTabs.onboarding")}
        items={items.data.map((i) => {
          const standing = onboardingStanding(i, today);
          const canAct = standing === "todo" || standing === "expired";
          return {
            id: i.id,
            title: i.name,
            meta: [
              t(enumLabelKey("onboardingItemKind", i.kind)),
              i.blocking ? t("gateway.engagement.onboarding.blocking") : null,
              t(enumLabelKey("verificationMethod", i.verification)),
              i.expiresOn
                ? t("gateway.engagement.documents.expires", {
                    date: formatDate(locale, i.expiresOn),
                  })
                : null,
            ],
            tag: {
              label: t(`gateway.engagement.onboarding.standing.${standing}`),
              tone:
                standing === "verified"
                  ? "success"
                  : standing === "review"
                    ? "accent"
                    : standing === "expired"
                      ? "danger"
                      : "warning",
            },
            ...(canAct
              ? {
                  detail:
                    i.kind === "Tax Form" ? (
                      <TaxFormForm
                        orgId={view.engagement.orgId}
                        asAccount={view.ctx.acting !== null}
                        kinds={APP_ENUMS.tax_form_kind.map((k) => ({
                          value: k,
                          label: t(enumLabelKey("taxFormKind", k)),
                        }))}
                      />
                    ) : i.kind === "Electronic Signature" ? (
                      <p className="m-0 text-text-13 text-text-secondary">
                        {t("gateway.engagement.onboarding.signHint")}
                      </p>
                    ) : i.kind === "Acknowledgment" ? (
                      // A training or briefing acknowledgment is the person's statement, no file
                      // (journey 42); the organization verifies it like any other step.
                      <div className="flex flex-col gap-8">
                        <p className="m-0 text-text-13 text-text-secondary">
                          {t("gatewayOnboarding.acknowledgeHint")}
                        </p>
                        <ActionButton
                          action={submitOnboardingItemAction.bind(null, i.id)}
                          label={t("gatewayOnboarding.acknowledge")}
                          variant="primary"
                          done={t("gatewayOnboarding.acknowledged")}
                        />
                      </div>
                    ) : i.kind === "Background Check" ? (
                      <p className="m-0 text-text-13 text-text-secondary">
                        {t("gateway.engagement.onboarding.backgroundHint")}
                      </p>
                    ) : i.kind === "Payout Details" ? (
                      <p className="m-0 text-text-13 text-text-secondary">
                        {t("gateway.engagement.onboarding.payoutHint")}
                      </p>
                    ) : (
                      <OnboardingUploadForm
                        orgId={view.engagement.orgId}
                        engagementId={view.engagement.id}
                        itemId={i.id}
                        name={i.name}
                      />
                    ),
                }
              : {}),
          };
        })}
      />
    </div>
  );
}

/** Engagement threads (Section 11.12 Communicate), the newest first, with a composer each. */
export async function MessagesTab({ view, t, locale }: TabProps) {
  const threads = await listThreads(view.ctx.db, view.engagement.id);
  if (!threads.ok) return <RegionError />;
  const messages = await listMessages(
    view.ctx.db,
    threads.data.map((th) => th.id),
  );
  if (!messages.ok) return <RegionError />;
  return (
    <div className="flex flex-col gap-16">
      {threads.data.length === 0 ? (
        <p className="m-0 text-text-14 text-text-secondary">
          {t("gateway.engagement.messages.empty")}
        </p>
      ) : null}
      {threads.data.map((th) => (
        <Card key={th.id} title={th.subject} meta={formatDate(locale, th.createdAt)}>
          <ol className="m-0 flex list-none flex-col gap-12 p-0">
            {messages.data
              .filter((m) => m.threadId === th.id)
              .map((m) => (
                <li
                  key={m.id}
                  className={`flex flex-col gap-2 rounded-control p-8 ${m.authorPersonId === view.ctx.personId ? "bg-bg-hover" : "bg-bg-surface"}`}
                >
                  <span className="text-text-12 text-text-secondary">
                    {m.authorName ?? t("gateway.engagement.messages.org")} ·{" "}
                    {formatDateTime(locale, m.sentAt)}
                  </span>
                  <span className="whitespace-pre-line">{m.body}</span>
                </li>
              ))}
          </ol>
          <MessageComposer threadId={th.id} />
        </Card>
      ))}
      <Section title={t("gateway.engagement.messages.new")}>
        <NewThreadForm engagementId={view.engagement.id} />
      </Section>
    </div>
  );
}

/** Invoices of the engagement's project with the payment tracker, submission and self-billing. */
export async function InvoicesTab({ view, t, locale, engagementKey }: TabProps) {
  const e = view.engagement;
  if (!hasArea(view, "money")) {
    return (
      <TabEmpty
        icon="Lock"
        sentence={t("gateway.engagement.invoices.closed")}
        actionLabel={t("gateway.engagement.messagesAction")}
        href={tabHref(engagementKey, "engagement.messages")}
      />
    );
  }
  const [invoices, selfBilling] = await Promise.all([
    readView(view.ctx.db, "invoices", {
      eq: { project_id: e.projectId, org_id: e.orgId },
      order: ["issued_on", "desc"],
    }),
    readView(view.ctx.db, "self_billing_agreements", { eq: { engagement_id: e.id } }),
  ]);
  if (!invoices.ok || !selfBilling.ok) return <RegionError />;
  const ids = invoices.data.map((inv) => inv.id ?? "").filter((id) => id !== "");
  const lines = await readView(view.ctx.db, "invoice_lines", {
    in: ["invoice_id", ids],
    order: ["line_number", "asc"],
  });
  if (!lines.ok) return <RegionError />;
  const agreement = selfBilling.data.find((a) => a.is_active);
  const currency = e.rateCurrency ?? "USD";
  const today = todayIso();
  const due = isoDaysFromToday(30);
  return (
    <div className="flex flex-col gap-16">
      {invoices.data.length === 0 ? (
        <p className="m-0 text-text-14 text-text-secondary">
          {t("gateway.engagement.invoices.empty")}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-12 p-0">
          {invoices.data.map((inv) => (
            <li key={inv.id ?? ""}>
              <PaymentSteps
                invoice={inv}
                lines={lines.data.filter((l) => l.invoice_id === inv.id)}
                locale={locale}
                t={t}
              />
            </li>
          ))}
        </ul>
      )}
      {["Contractor", "Crew", "Staff", "Vendor", "Artist", "Sponsor"].includes(e.roleType) ? (
        <Section title={t("gateway.engagement.invoices.submitTitle")}>
          <InvoiceForm
            engagementId={e.id}
            currency={currency}
            suggestedNumber={`INV-${today.replaceAll("-", "")}`}
            today={today}
            due={due}
          />
        </Section>
      ) : null}
      {["Crew", "Staff", "Contractor"].includes(e.roleType) ? (
        <Section title={t("gateway.engagement.invoices.selfBilling")}>
          <p className="m-0 text-text-13 text-text-secondary">
            {t("gateway.engagement.invoices.selfBillingBody")}
          </p>
          {agreement ? (
            <div className="flex flex-wrap items-center gap-8">
              <Tag tone="success">{t("gateway.engagement.invoices.selfBillingOn")}</Tag>
              <ActionButton
                action={revokeSelfBillingAction.bind(null, e.id)}
                label={t("gateway.engagement.invoices.selfBillingStop")}
                variant="ghost"
              />
            </div>
          ) : (
            <div>
              <ActionButton
                action={agreeSelfBillingAction.bind(null, e.id)}
                label={t("gateway.engagement.invoices.selfBillingAgree")}
              />
            </div>
          )}
        </Section>
      ) : null}
    </div>
  );
}
