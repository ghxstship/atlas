/**
 * The capability each operation requires, from `packages/schemas/capabilities.yaml`.
 *
 * One rule per resource: list and get need `read`; create, update and delete need `write`
 * unless `create` or `delete` says otherwise; each action names its own capability, and an
 * action without one inherits `read` (GET) or `write` (POST). External parties reach rows
 * through their engagements (Section 8.7); the capability names the internal permission that
 * governs the same operation.
 */

export interface CapabilityRule {
  readonly read?: string;
  readonly write?: string;
  readonly create?: string;
  readonly delete?: string;
  readonly actions?: Readonly<Record<string, string>>;
}

const rw = (
  read: string,
  write: string,
  more: Omit<CapabilityRule, "read" | "write"> = {},
): CapabilityRule => ({
  read,
  write,
  ...more,
});

const CANON_READ = "canon.taxonomy.read";

export const RESOURCE_CAPABILITIES: Readonly<Record<string, CapabilityRule>> = {
  // Home and Activity
  home: { actions: { get: "home.dashboard.read" } },
  activityEvents: { read: "activity.feed.read" },

  // Projects
  projects: rw("projects.project.read", "projects.project.write", {
    create: "projects.project.create",
    delete: "projects.project.archive",
    actions: {
      transition: "projects.project.archive",
      passGate: "projects.gate.transition",
      gateReadiness: "projects.gate.read",
      duplicate: "projects.project.create",
    },
  }),
  scopeNodes: rw("projects.project.read", "projects.scope.write"),
  projectPhaseTransitions: { read: "projects.gate.read" },
  gateEvidence: rw("projects.gate.read", "projects.gate.evidence.write"),

  // Schedule
  scheduleBaselines: rw("schedule.timeline.read", "schedule.baseline.write"),
  scheduleActuals: rw("schedule.timeline.read", "schedule.timeline.write"),
  calendars: rw("schedule.timeline.read", "schedule.timeline.write"),
  recordDependencies: rw("schedule.timeline.read", "schedule.timeline.write"),
  recordRecurrences: rw("work.record.read", "work.recurring.write"),

  // Work
  records: rw("work.record.read", "work.record.write", {
    actions: {
      transition: "work.record.write",
      duplicate: "work.record.write",
      archive: "work.record.write",
    },
  }),
  recordStateTransitions: { read: "work.record.read" },
  recordReplans: { read: "work.record.read" },
  recordChecklistItems: rw("work.record.read", "work.punch_list.write"),
  recordWatchers: rw("work.record.read", "inbox.notifications.write"),
  workOrders: rw("work.work_order.read", "work.work_order.write"),
  workOrderBids: rw("work.work_order.read", "work.work_order.write", {
    actions: { award: "work.work_order.award" },
  }),

  // Show
  runsOfShow: rw("show.run_of_show.read", "show.run_of_show.write"),
  cues: rw("show.run_of_show.read", "show.run_of_show.write", {
    actions: { fire: "show.cue.call" },
  }),
  daySheets: rw("show.run_of_show.read", "show.day_sheet.write", {
    actions: { publish: "show.call_sheet.publish" },
  }),
  callSheets: rw("show.run_of_show.read", "show.day_sheet.write", {
    actions: { publish: "show.call_sheet.publish" },
  }),

  // Knowledge
  sops: rw("knowledge.sop.read", "knowledge.sop.write"),
  sopAcknowledgments: rw("knowledge.sop.read", "knowledge.sop.acknowledge"),
  documents: rw("knowledge.document.read", "knowledge.document.write"),
  documentVersions: rw("knowledge.document.read", "knowledge.document.write"),
  verbiageTerms: rw("knowledge.verbiage.read", "knowledge.verbiage.write"),

  // Places
  venues: rw("places.venue.read", "places.venue.write"),
  spaces: rw("places.venue.read", "places.space.write"),
  zones: rw("places.venue.read", "places.space.write"),
  capabilityDocuments: rw("places.venue.read", "places.capability_document.write"),
  sitePlans: rw("places.venue.read", "places.site_plan.write"),
  sitePlanPins: rw("places.venue.read", "places.site_plan.write"),
  geofences: rw("places.venue.read", "org.time_attendance.write"),
  requirements: rw("projects.project.read", "projects.scope.write"),
  reconciliations: rw("advancing.packet.read", "advancing.reconciliation.write"),
  reconciliationLines: { read: "advancing.packet.read" },

  // Logistics
  shipments: rw("logistics.shipment.read", "logistics.shipment.write"),
  shipmentLines: rw("logistics.shipment.read", "logistics.shipment.write"),
  dockSlots: rw("logistics.shipment.read", "logistics.dock_slot.write", {
    actions: { checkIn: "logistics.yard.write" },
  }),
  gateQueueEntries: rw("logistics.shipment.read", "logistics.yard.write", {
    actions: { release: "logistics.release.approve" },
  }),
  marshallingLogEntries: rw("logistics.shipment.read", "logistics.yard.write"),

  // Advancing
  advancePackets: rw("advancing.packet.read", "advancing.packet.write", {
    actions: { send: "advancing.packet.send" },
  }),
  advanceSections: rw("advancing.packet.read", "advancing.packet.write"),
  advanceRecipients: rw("advancing.packet.read", "advancing.packet.write"),
  advanceSubmissions: rw("advancing.packet.read", "advancing.packet.write"),
  advancePromotions: rw("advancing.packet.read", "advancing.submission.review"),
  riders: rw("advancing.packet.read", "advancing.rider.write"),
  riderLines: rw("advancing.packet.read", "advancing.rider.write"),

  // Hospitality
  fulfillments: rw("hospitality.fulfillment.read", "hospitality.fulfillment.write"),
  fulfillmentLines: rw("hospitality.fulfillment.read", "hospitality.accommodation.write"),
  beos: rw("hospitality.fulfillment.read", "hospitality.beo.write"),
  beoLines: rw("hospitality.fulfillment.read", "hospitality.beo.write"),

  // Assets
  assetClasses: rw("assets.asset.read", "assets.asset.write"),
  assetUnits: rw("assets.asset.read", "assets.asset.write", {
    actions: { transition: "assets.write_off.approve", scan: "assets.asset.read" },
  }),
  assetLots: rw("assets.asset.read", "assets.asset.write"),
  assetIdentifiers: rw("assets.asset.read", "assets.asset.write"),
  assetCustodyEntries: rw("assets.asset.read", "assets.custody.write"),
  assetMaintenanceEvents: rw("assets.asset.read", "assets.maintenance.write"),
  assetDamageReports: rw("assets.asset.read", "assets.damage.write"),

  // People
  roleAssignments: rw("people.directory.read", "people.role.write"),
  requisitions: rw("people.requisition.read", "people.requisition.write", {
    actions: { approve: "people.requisition.approve" },
  }),
  offers: rw("people.profile.read", "people.offer.write", {
    actions: {
      send: "people.offer.approve",
      accept: "me.work_details.write",
      decline: "me.work_details.write",
      counter: "me.work_details.write",
    },
  }),
  agreements: rw("people.profile.read", "people.agreement.write", {
    actions: { sign: "me.account.write" },
  }),

  // Crew
  shifts: rw("crew.shift.read", "crew.shift.write", { actions: { accept: "crew.swap.request" } }),
  shiftSwaps: rw("crew.shift.read", "crew.swap.request", {
    actions: { approve: "crew.swap.approve", decline: "crew.swap.approve" },
  }),
  timeEntries: rw("crew.time_entry.read", "crew.time_entry.write"),
  timeEntryCorrections: rw("crew.time_entry.read", "crew.time_entry.write", {
    actions: { approve: "crew.timesheet.approve" },
  }),
  timeEntryAuditEntries: { read: "crew.time_entry.read" },
  timesheets: rw("crew.timesheet.read", "crew.timesheet.submit", {
    actions: { approve: "crew.timesheet.approve" },
  }),
  timesheetApprovals: { read: "crew.timesheet.read" },
  kioskDevices: rw("crew.schedule.read", "org.time_attendance.write"),
  rateCards: rw("crew.rate_card.read", "crew.rate_card.write"),
  rateCardLines: rw("crew.rate_card.read", "crew.rate_card.write"),
  payRates: rw("crew.rate_card.read", "crew.rate_card.write"),
  overtimeRules: rw("crew.rate_card.read", "org.time_attendance.write"),
  unionLocalRates: rw("crew.rate_card.read", "crew.rate_card.write"),
  wageDeterminations: rw("crew.rate_card.read", "crew.rate_card.write"),
  payPeriods: rw("crew.schedule.read", "crew.pay_period.manage"),
  payrollRuns: rw("crew.schedule.read", "crew.pay_period.manage"),
  payrollLines: { read: "data.restricted.read.payroll" },
  payrollExports: rw("crew.schedule.read", "crew.payroll.export"),
  earningCodes: rw("crew.rate_card.read", "org.payroll.write"),
  perDiems: rw("crew.rate_card.read", "crew.rate_card.write"),
  timeOffPolicies: rw("crew.schedule.read", "org.payroll.write"),
  timeOffRequests: rw("crew.schedule.read", "crew.time_off.request", {
    actions: { approve: "crew.time_off.approve", decline: "crew.time_off.approve" },
  }),

  // Credentials
  credentialCategories: rw("credentials.credential.read", "credentials.category.write"),
  credentials: rw("credentials.credential.read", "credentials.credential.issue", {
    actions: { revoke: "credentials.credential.revoke" },
  }),
  accessGridEntries: rw("credentials.credential.read", "credentials.access_grid.write"),
  accessScans: rw("credentials.scan_log.read", "credentials.scan.write"),
  certifications: rw("people.certification.read", "people.role.write"),
  certificationHolders: rw("people.certification.read", "people.certification.write", {
    actions: { verify: "people.certification.verify" },
  }),

  // Finance
  budgets: rw("finance.budget.read", "finance.budget.write", {
    actions: { summary: "finance.budget.read" },
  }),
  budgetLines: rw("finance.budget.read", "finance.budget.write"),
  expenses: rw("finance.expense.read", "finance.expense.write", {
    actions: { approve: "finance.expense.approve" },
  }),
  contingencyDraws: rw("finance.budget.read", "finance.budget.approve"),
  changeOrders: rw("finance.change_order.read", "finance.change_order.write", {
    actions: { approve: "finance.change_order.approve" },
  }),
  changeOrderLines: rw("finance.change_order.read", "finance.change_order.price"),
  accountingPeriods: rw("finance.journal.read", "finance.period.manage", {
    actions: { transition: "finance.period.close" },
  }),
  journalEntries: rw("finance.journal.read", "finance.journal.write", {
    actions: { post: "finance.journal.post" },
  }),
  journalLines: rw("finance.journal.read", "finance.journal.write"),
  postingLines: { read: "finance.journal.read", actions: { export: "finance.upl.export" } },
  invoices: rw("finance.invoice.read", "finance.invoice.write", {
    actions: { approve: "finance.invoice.approve" },
  }),
  invoiceLines: rw("finance.invoice.read", "finance.invoice.write"),
  paymentApplications: rw("finance.payment.read", "finance.payment.write"),
  billingDraws: rw("finance.invoice.read", "finance.invoice.write"),
  costCenters: rw("finance.gl.read", "finance.cost_center.write"),
  taxJurisdictions: rw("finance.gl.read", "org.legal_entities.write"),
  taxRates: rw("finance.gl.read", "org.legal_entities.write"),
  fxRates: { read: "finance.gl.read" },
  priceBooks: rw("procurement.catalog.read", "procurement.catalog.write"),

  // Procurement
  rfqs: rw("procurement.rfq.read", "procurement.rfq.write", {
    actions: { issue: "procurement.rfq.issue" },
  }),
  rfqInvitations: rw("procurement.rfq.read", "procurement.rfq.write"),
  rfqResponses: rw("procurement.bid.read", "procurement.rfq.read", {
    actions: { submit: "procurement.rfq.read" },
  }),
  rfqResponseLines: rw("procurement.bid.read", "procurement.rfq.read"),
  purchaseOrders: rw("procurement.po.read", "procurement.po.write", {
    actions: { approve: "finance.po.approve", acknowledge: "procurement.po.read" },
  }),
  poLines: rw("procurement.po.read", "procurement.po.write"),
  poChangeOrders: rw("procurement.po.read", "procurement.po.write", {
    actions: { approve: "finance.po.approve" },
  }),
  goodsReceipts: rw("procurement.po.read", "procurement.receipt.write"),
  receiptLines: rw("procurement.po.read", "procurement.receipt.write"),
  invoiceMatches: rw("procurement.po.read", "procurement.invoice_match.write"),
  catalogBindings: rw("procurement.catalog.read", "procurement.catalog.write"),
  vendorProducts: rw("procurement.catalog.read", "procurement.catalog.write"),

  // Vendors
  vendors: rw("vendors.vendor.read", "vendors.vendor.write"),
  vendorClasses: rw("vendors.vendor.read", "vendors.class.write"),
  vendorClassAssignments: rw("vendors.vendor.read", "vendors.class.write"),
  prequalifications: rw("vendors.vendor.read", "vendors.vendor.write", {
    actions: { transition: "vendors.prequalification.approve" },
  }),
  insuranceCertificates: rw("vendors.vendor.read", "vendors.coi.write"),
  vendorScorecards: rw("vendors.vendor.read", "vendors.scorecard.write"),
  sponsorEntitlements: rw("vendors.vendor.read", "vendors.entitlement.write"),

  // Safety
  inspectionTemplates: rw("safety.inspection.read", "safety.inspection_template.write"),
  inspectionItems: rw("safety.inspection.read", "safety.inspection_template.write"),
  inspections: rw("safety.inspection.read", "safety.inspection.write", {
    actions: { signOff: "safety.inspection.sign_off" },
  }),
  inspectionResults: rw("safety.inspection.read", "safety.inspection.write"),
  permitRequirements: rw("safety.permit.read", "safety.permit.write"),
  incidents: rw("safety.incident.read", "safety.incident.write", {
    actions: { close: "safety.incident.close" },
  }),
  incidentParties: rw("safety.incident.read", "safety.incident.write"),
  incidentMediaItems: rw("safety.incident.read", "safety.incident.write"),
  dispatchAssignments: rw("safety.incident.read", "safety.incident.dispatch"),
  medicalEncounters: rw("data.restricted.read.medical", "safety.incident.write"),
  crisisAlerts: rw("safety.incident.read", "safety.incident.dispatch"),
  emergencyCodes: rw("safety.incident.read", "safety.emergency_code.write"),
  radioChannels: rw("safety.incident.read", "safety.radio_channel.write"),

  // Opportunities
  opportunities: rw("opportunities.posting.read", "opportunities.posting.write", {
    actions: { transition: "opportunities.posting.publish" },
  }),
  opportunityPositions: rw("opportunities.posting.read", "opportunities.posting.write"),
  opportunityRequirements: rw("opportunities.posting.read", "opportunities.posting.write"),
  opportunityQuestions: rw("opportunities.posting.read", "opportunities.posting.write"),
  payTransparencyRules: { read: "opportunities.posting.read" },
  applications: rw("opportunities.application.read", "me.work_details.write", {
    actions: { transition: "opportunities.selection.decide" },
  }),
  applicationAnswers: rw("opportunities.application.read", "me.work_details.write"),
  bids: rw("opportunities.application.read", "me.work_details.write", {
    actions: { unseal: "procurement.bid.unseal" },
  }),
  bidLines: rw("opportunities.application.read", "me.work_details.write"),
  agencySlates: rw("opportunities.application.read", "me.work_details.write"),
  shortlistEntries: rw("opportunities.application.read", "opportunities.application.review"),
  interviews: rw("opportunities.application.read", "opportunities.application.review"),
  engagements: rw("opportunities.engagement.read", "opportunities.offer.send", {
    actions: { transition: "opportunities.engagement.write" },
  }),
  engagementDocuments: rw("opportunities.engagement.read", "opportunities.engagement.write"),
  onboardingRequirements: rw("opportunities.engagement.read", "org.gateway.write"),
  onboardingItems: rw("opportunities.engagement.read", "opportunities.onboarding.write"),
  onboardingVerifications: rw("opportunities.engagement.read", "opportunities.onboarding.write"),
  talentPools: rw("opportunities.engagement.read", "opportunities.pool.write"),
  poolMembers: rw("opportunities.engagement.read", "opportunities.pool.write"),
  ratings: rw("opportunities.engagement.read", "opportunities.rating.write"),
  ratingReplies: rw("opportunities.engagement.read", "me.profile.write"),

  // Gateway
  marketplace: { actions: { search: "opportunities.posting.read" } },
  savedSearches: rw("me.profile.write", "me.profile.write"),
  opportunityAlerts: { read: "me.notifications.write" },
  listingReports: rw("opportunities.marketplace.manage", "me.profile.write"),
  moderationActions: rw("opportunities.marketplace.manage", "opportunities.marketplace.manage"),
  profileShares: rw("me.profile.write", "me.profile.write"),
  availabilityCalendars: rw("me.profile.write", "me.profile.write"),
  availabilityBlocks: rw("me.profile.write", "me.profile.write"),
  engagementThreads: rw("opportunities.engagement.read", "opportunities.engagement.write"),
  engagementMessages: rw("opportunities.engagement.read", "opportunities.engagement.write"),
  taxForms: rw("data.restricted.read.tax", "me.work_details.write"),
  payoutAccounts: rw("data.restricted.read.banking", "me.work_details.write"),
  backgroundChecks: rw("opportunities.engagement.read", "opportunities.onboarding.write"),

  // Identity
  me: { actions: { get: "me.profile.write" } },
  people: rw("people.directory.read", "people.profile.write"),
  organizations: rw("org.settings.read", "org.general.write", { create: "me.account.write" }),
  memberships: rw("org.members.read", "org.members.manage", {
    create: "org.members.invite",
    actions: { offboard: "org.members.manage" },
  }),
  membershipRoles: rw("org.members.read", "org.members.manage"),
  projectAssignments: rw("projects.project.read", "projects.members.manage"),
  projectAssignmentRoles: rw("projects.project.read", "projects.members.manage"),
  accountMemberships: rw("me.account.write", "me.account.write"),
  accountMembershipRoles: rw("me.account.write", "me.account.write"),
  organizationRelationships: rw("vendors.vendor.read", "vendors.vendor.write"),
  representations: rw("me.profile.write", "me.profile.write"),
  joinRequests: rw("org.members.read", "me.account.write", {
    actions: { approve: "org.members.invite", decline: "org.members.invite" },
  }),
  invitationLinks: rw("org.members.read", "org.members.invite", {
    actions: { revoke: "org.members.invite" },
  }),
  invites: rw("org.members.read", "org.members.invite"),
  verifiedDomains: rw("org.settings.read", "org.security.write"),
  offboardingChecklists: rw("org.members.read", "org.members.manage"),
  personProfiles: rw("people.directory.read", "me.profile.write"),
  organizationProfiles: rw("org.settings.read", "org.profile.write"),
  profileSections: rw("people.directory.read", "me.profile.write"),
  profileVisibilityRules: rw("me.profile.write", "me.profile.write"),
  profileHandles: rw("people.directory.read", "me.profile.write"),
  verifications: rw("people.directory.read", "org.profile.write"),
  blocks: rw("me.account.write", "me.account.write"),

  // Settings
  subscriptions: rw("org.billing.read", "org.billing.manage"),
  plans: { read: "org.billing.read" },
  workspaces: rw("org.settings.read", "org.workspaces.manage"),
  workspaceMembers: rw("org.settings.read", "org.workspaces.manage"),
  teams: rw("org.settings.read", "org.teams.manage"),
  teamMembers: rw("org.settings.read", "org.teams.manage"),
  orgBrandings: rw("org.settings.read", "org.white_label.write"),
  orgLegalEntities: rw("org.settings.read", "org.legal_entities.write"),
  orgIpAllowlistEntries: rw("org.settings.read", "org.security.write"),
  roles: rw("org.members.read", "org.roles.manage"),
  capabilities: { read: "org.members.read" },
  roleCapabilities: rw("org.members.read", "org.roles.manage"),
  userCapabilityGrants: rw("org.members.read", "org.members.manage"),
  recordGrants: rw("org.members.read", "org.access_grants.manage"),
  delegations: rw("org.members.read", "me.out_of_office.write"),
  spendAuthorityLimits: rw("org.settings.read", "org.spend_authority.write"),
  separationOfDutiesRules: rw("org.settings.read", "org.separation_of_duties.write"),
  columnClassifications: { read: "org.settings.read" },
  accessReviewCampaigns: rw("org.members.read", "org.access_reviews.manage"),
  accessReviewItems: rw("org.members.read", "org.access_reviews.manage"),
  breakGlassSessions: rw("audit.log.read", "org.break_glass.use"),
  projectShares: rw("projects.project.read", "org.access_grants.manage"),
  scimGroupMappings: rw("org.settings.read", "org.security.write"),
  apiKeys: rw("org.settings.read", "org.api_keys.manage"),
  serviceAccounts: rw("org.settings.read", "org.api_keys.manage"),
  oauthApps: rw("org.settings.read", "org.integrations.manage"),
  oauthGrants: rw("me.account.write", "me.account.write"),
  integrations: rw("org.settings.read", "org.integrations.manage"),
  webhookEndpoints: rw("org.settings.read", "org.webhooks.manage"),
  webhookDeliveries: rw("org.settings.read", "org.webhooks.manage"),
  webhookEventTypes: { read: "org.settings.read" },
  settingDefinitions: { read: "org.settings.read" },
  settingValues: rw("org.settings.read", "org.general.write"),
  settingLocks: rw("org.settings.read", "org.security.write"),
  auditEvents: { read: "audit.log.read" },
  consentRecords: rw("data.request.manage", "me.account.write"),
  dsarRequests: rw("data.request.manage", "data.request.manage"),
  retentionPolicies: { read: "data.retention.write" },
  orgExports: rw("data.export.run", "data.export.run"),
  aiSettings: rw("org.settings.read", "org.ai.write"),

  // Reports
  reportDefinitions: rw("reports.report.read", "reports.report.write"),
  reportRuns: rw("reports.report.read", "reports.report.export"),
  reportSchedules: rw("reports.report.read", "reports.schedule.write"),
  dashboards: rw("reports.report.read", "reports.report.write"),
  dashboardTiles: rw("reports.report.read", "reports.report.write"),
  reports: {
    actions: {
      budgetVsActual: "finance.budget.read",
      laborCost: "data.restricted.read.payroll",
      poExposure: "procurement.po.read",
      incidentRates: "safety.incident.read",
      finalCostReport: "finance.budget.read",
      gateReadiness: "projects.gate.read",
    },
  },

  // Platform
  customObjectTypes: rw("org.settings.read", "org.custom_objects.write"),
  customObjectFields: rw("org.settings.read", "org.custom_objects.write"),
  objects: rw("work.record.read", "work.record.write"),
  customObjectRelations: rw("work.record.read", "work.record.write"),
  customFieldDefinitions: rw("org.settings.read", "org.custom_fields.write"),
  customFieldValues: rw("work.record.read", "work.record.write"),
  orgStateLabels: rw("org.settings.read", "org.views.write"),
  importJobs: rw("org.settings.read", "data.classification.write"),
  importBatches: rw("org.settings.read", "data.classification.write"),
  importRowResults: { read: "org.settings.read" },
  importMappingProfiles: rw("org.settings.read", "data.classification.write"),
  mergeReviews: rw("org.settings.read", "data.classification.write"),
  exportJobs: rw("data.export.run", "data.export.run"),
  savedViews: rw("my_work.items.read", "org.views.write"),
  approvalPolicies: rw("org.settings.read", "org.approval_policies.write"),
  approvalInstances: rw("inbox.notifications.read", "inbox.notifications.write"),
  approvalDecisions: rw("inbox.notifications.read", "inbox.notifications.write"),
  commentThreads: rw("work.record.read", "work.record.write"),
  comments: rw("work.record.read", "work.record.write"),
  notifications: rw("inbox.notifications.read", "inbox.notifications.write"),
  notificationPreferences: rw("me.notifications.write", "me.notifications.write"),
  calendarFeeds: rw("me.calendar_feeds.write", "me.calendar_feeds.write"),
  trashItems: rw("work.record.read", "work.record.write"),
  templates: rw("projects.project.read", "projects.template.write"),
  templateApplications: rw("projects.project.read", "projects.project.create"),

  // Canon
  canonIntake: rw(CANON_READ, "canon.extension.write"),
  canonExtensions: { actions: { propose: "canon.extension.write" } },
};

/** Every canon read resource needs only the taxonomy read capability. */
export function canonRule(op: string): CapabilityRule | undefined {
  return op.startsWith("canon") ? { read: CANON_READ } : undefined;
}

/**
 * Registry capabilities no operation requires yet, each with the reason. The contract test
 * fails when a capability is neither used nor listed here.
 */
export const UNUSED_CAPABILITY_ALLOWLIST: Readonly<Record<string, string>> = {
  "home.alerts.read":
    "Alerts are delivered through notifications; a dedicated alerts feed arrives with the Home module.",
  "projects.project.export": "Exports run through export jobs, which require data.export.run.",
  "projects.settings.write":
    "Project settings are fields of the project and its settings registry values.",
  "schedule.milestone.write":
    "Milestones are records of kind Milestone and use the record write capability.",
  "schedule.timeline.export": "Exports run through export jobs.",
  "work.record.export": "Exports run through export jobs.",
  "assets.asset.export": "Exports run through export jobs.",
  "hospitality.beo.approve":
    "BEO approval goes through approval instances until the BEO lifecycle lands.",
  "procurement.bid.award": "RFQ award arrives with the RFQ lifecycle in Wave 3.",
  "procurement.po.send": "Sending a PO is part of the purchase order transition.",
  "finance.payment.approve": "Payment runs arrive with the payment module in Wave 3.",
  "vendors.bank_details.write":
    "Bank details are payout accounts held by the payment provider; edited through Gateway.",
  "knowledge.sop.publish": "SOP publishing is part of the SOP lifecycle in Wave 3.",
  "audit.log.export": "Audit exports run through export jobs with step-up authentication.",
  "org.view_as_role.use": "A UI preview mode with no API operation (Section 8.4).",
  "org.modules.write": "Module switches are setting values.",
  "org.numbering.write": "Numbering formats are setting values.",
  "org.automations.write": "Automations arrive with A18 in Wave 2.",
  "org.scheduling.write": "Scheduling rules are setting values.",
  "org.communication.write": "Communication rules are setting values (workforce suite, A29).",
  "org.notifications.write": "Org notification defaults are setting values.",
  "org.help.write": "Help settings are setting values (A31).",
  "org.localization.write": "Localization defaults are setting values.",
  "org.usage.read": "Usage reads arrive with A18 billing in Wave 2.",
  "org.partner.manage": "Used by the create client organization operation.",
  "org.legal.read": "Legal acceptance records arrive with A21.",
  "org.legal.accept": "Legal acceptance records arrive with A21.",
  "org.support_session.grant":
    "Support sessions are granted from the operator console flow (Section 8).",
  "org.ownership.transfer": "Ownership transfer arrives with A30 offboarding in Wave 3.",
  "org.organization.archive": "Org lifecycle operations arrive with A18 billing.",
  "org.organization.delete":
    "Org deletion follows the cancellation timeline of Section 14.7 (A21).",
  "org.departments.write": "Departments in use are setting values.",
  "org.locations.write": "Location defaults are setting values.",
  "org.templates.write": "Org templates use projects.template.write on the templates resource.",
  "data.export.confidential": "Classification-aware export checks run inside export jobs.",
  "data.export.restricted": "Classification-aware export checks run inside export jobs.",
  "data.legal_hold.manage": "Legal holds arrive with A21.",
  "data.restricted.read.government_id": "No government identifier column is exposed yet.",
  "me.preferences.write": "Preferences are personal setting values.",
  "me.api_tokens.write": "Personal API tokens arrive with A30.",
};
