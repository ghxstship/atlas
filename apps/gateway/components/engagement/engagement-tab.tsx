import { getLocale } from "next-intl/server";
import type { ComponentType } from "react";
import { loadEngagementTab } from "@/lib/engagement";
import { getTranslate } from "@/lib/shell/translate";
import type { TabProps } from "./tab-context";
import {
  GuestListTab,
  HospitalityTab,
  RiderTab,
  RosterTab,
  SetTimesTab,
  SettlementTab,
} from "./tabs-artist";
import {
  ApprovalsTab,
  AssetApprovalsTab,
  ChangeOrdersTab,
  DeliverablesTab,
  EntitlementsTab,
  RecordsTab,
  RunOfShowTab,
  ScopeTab,
} from "./tabs-client";
import {
  DocumentsTab,
  InvoicesTab,
  MessagesTab,
  OfferTab,
  OnboardingTab,
  OverviewTab,
} from "./tabs-common";
import {
  CredentialsTab,
  PerDiemTab,
  PositionsTab,
  ShiftsTab,
  TimesheetsTab,
  TimeTab,
  TrainingTab,
  TravelTab,
} from "./tabs-crew";
import { ProjectDetailsTab } from "./tabs-project-details";
import { ReportsTab } from "./tabs-reports";
import { CrewTab } from "./tabs-roster";
import {
  AdvanceTab,
  BidTab,
  ComplianceTab,
  DeliveriesTab,
  PurchaseOrdersTab,
  SubmittalsTab,
} from "./tabs-vendor";

type Tab = ComponentType<TabProps>;

const ScheduleTab: Tab = (p) => (
  <RecordsTab {...p} emptyKey="gateway.engagement.schedule.empty" icon="CalendarDays" calendar />
);
const ActivationScheduleTab: Tab = (p) => (
  <RecordsTab
    {...p}
    kinds={["Event", "Distribution", "Booking"]}
    emptyKey="gateway.engagement.activation.empty"
    icon="Megaphone"
    calendar
  />
);
const ProofOfPerformanceTab: Tab = (p) => <DocumentsTab {...p} kinds={["Proof of Performance"]} />;

/** Every engagement tab of the Gateway sitemap, by node id. */
export const ENGAGEMENT_TABS: Readonly<Record<string, Tab>> = {
  "engagement.overview": OverviewTab,
  "engagement.roster": RosterTab,
  "engagement.approvals": ApprovalsTab,
  "engagement.bid": BidTab,
  "engagement.scope": ScopeTab,
  "engagement.offer": OfferTab,
  "engagement.onboarding": OnboardingTab,
  "engagement.project-details": ProjectDetailsTab,
  "engagement.training": TrainingTab,
  "engagement.positions": PositionsTab,
  "engagement.entitlements": EntitlementsTab,
  "engagement.asset-approvals": AssetApprovalsTab,
  "engagement.schedule": ScheduleTab,
  "engagement.run-of-show": RunOfShowTab,
  "engagement.change-orders": ChangeOrdersTab,
  "engagement.purchase-orders": PurchaseOrdersTab,
  "engagement.deliveries": DeliveriesTab,
  "engagement.submittals": SubmittalsTab,
  "engagement.deliverables": DeliverablesTab,
  "engagement.time": TimeTab,
  "engagement.shifts": ShiftsTab,
  "engagement.timesheets": TimesheetsTab,
  "engagement.travel-and-lodging": TravelTab,
  "engagement.per-diem": PerDiemTab,
  "engagement.advance": AdvanceTab,
  "engagement.crew": CrewTab,
  "engagement.rider": RiderTab,
  "engagement.set-times": SetTimesTab,
  "engagement.hospitality": HospitalityTab,
  "engagement.guest-list": GuestListTab,
  "engagement.activation-schedule": ActivationScheduleTab,
  "engagement.proof-of-performance": ProofOfPerformanceTab,
  "engagement.credentials": CredentialsTab,
  "engagement.compliance": ComplianceTab,
  "engagement.settlement": SettlementTab,
  "engagement.reports": ReportsTab,
  "engagement.invoices": InvoicesTab,
  "engagement.documents": DocumentsTab,
  "engagement.messages": MessagesTab,
};

/** One engagement tab page: 404 unless the tab is in the viewer's set, then its content. */
export async function EngagementTabPage({
  tab,
  engagementKey,
}: {
  tab: string;
  engagementKey: string;
}) {
  const [view, t, locale] = await Promise.all([
    loadEngagementTab(engagementKey, tab),
    getTranslate(),
    getLocale(),
  ]);
  const Content = ENGAGEMENT_TABS[tab];
  if (!Content) throw new Error(`No content for engagement tab ${tab}.`);
  return (
    <section
      aria-label={t(
        `nav.gateway.engagementTabs.${tab.slice("engagement.".length).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}`,
      )}
      className="flex flex-col gap-16"
    >
      <Content view={view} t={t} locale={locale} engagementKey={engagementKey} />
    </section>
  );
}
