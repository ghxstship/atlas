/**
 * Resource coverage derived from the build spec. Each entry names a core entity from
 * Section 4.2 (Atlas modules), 4.4 (Gateway), 4.8 (identity) or 7.2 (canon read endpoints) and
 * the operationIds that must exist for it. The contract tests fail when any is missing.
 */
import type { Module } from "./types.ts";

export interface CoverageEntry {
  readonly module: Module;
  /** The entity as the spec names it. */
  readonly entity: string;
  readonly operations: readonly string[];
}

const crud = (op: string) => [`${op}.list`, `${op}.get`, `${op}.create`, `${op}.update`];
const read = (op: string) => [`${op}.list`, `${op}.get`];

export const SECTION_COVERAGE: readonly CoverageEntry[] = [
  // Section 4.2
  {
    module: "Home",
    entity: "Org dashboard, my work, gate readiness, alerts",
    operations: ["home.get"],
  },
  {
    module: "Projects",
    entity: "Project",
    operations: [...crud("projects"), "projects.transition", "projects.passGate"],
  },
  { module: "Projects", entity: "Scope tree", operations: crud("scopeNodes") },
  {
    module: "Projects",
    entity: "Jurisdiction",
    operations: ["projects.update", "canonJurisdictions.list"],
  },
  {
    module: "Projects",
    entity: "Gate evidence",
    operations: [...crud("gateEvidence"), "projects.gateReadiness"],
  },
  { module: "Activity", entity: "Activity feed", operations: read("activityEvents") },
  { module: "Schedule", entity: "Timeline records", operations: ["records.list"] },
  { module: "Schedule", entity: "Baselines", operations: read("scheduleBaselines") },
  { module: "Schedule", entity: "Dependencies", operations: read("recordDependencies") },
  { module: "Schedule", entity: "Calendars", operations: crud("calendars") },
  { module: "Schedule", entity: "Actuals", operations: crud("scheduleActuals") },
  {
    module: "Work",
    entity: "Task, Build, Strike, Rehearsal and Training records",
    operations: [...crud("records"), "records.transition"],
  },
  {
    module: "Work",
    entity: "Work orders with bids",
    operations: [...crud("workOrders"), ...read("workOrderBids")],
  },
  { module: "Show", entity: "Run of show", operations: crud("runsOfShow") },
  { module: "Show", entity: "Cues", operations: [...crud("cues"), "cues.fire"] },
  { module: "Show", entity: "Day sheets", operations: crud("daySheets") },
  { module: "Show", entity: "Call sheets", operations: crud("callSheets") },
  {
    module: "Knowledge",
    entity: "SOPs with acknowledgment",
    operations: [...crud("sops"), "sopAcknowledgments.create"],
  },
  {
    module: "Knowledge",
    entity: "Documents with versions",
    operations: [...crud("documents"), "documentVersions.create"],
  },
  { module: "Knowledge", entity: "Controlled vocabulary", operations: crud("verbiageTerms") },
  { module: "Places", entity: "Venues", operations: crud("venues") },
  { module: "Places", entity: "Spaces", operations: crud("spaces") },
  { module: "Places", entity: "Zones", operations: crud("zones") },
  { module: "Places", entity: "Capability documents", operations: crud("capabilityDocuments") },
  {
    module: "Places",
    entity: "Site plans",
    operations: [...crud("sitePlans"), ...crud("sitePlanPins")],
  },
  {
    module: "Logistics",
    entity: "Shipments",
    operations: [...crud("shipments"), ...crud("shipmentLines")],
  },
  {
    module: "Logistics",
    entity: "Dock slots",
    operations: [...crud("dockSlots"), "dockSlots.checkIn"],
  },
  { module: "Logistics", entity: "Gate queue", operations: crud("gateQueueEntries") },
  {
    module: "Logistics",
    entity: "Staging and release",
    operations: [...read("marshallingLogEntries"), "gateQueueEntries.release"],
  },
  {
    module: "Advancing",
    entity: "Advance packets",
    operations: [...crud("advancePackets"), "advancePackets.send"],
  },
  { module: "Advancing", entity: "Sections", operations: crud("advanceSections") },
  { module: "Advancing", entity: "Recipients", operations: read("advanceRecipients") },
  { module: "Advancing", entity: "Submissions", operations: read("advanceSubmissions") },
  { module: "Advancing", entity: "Riders", operations: [...crud("riders"), ...crud("riderLines")] },
  {
    module: "Advancing",
    entity: "Reconciliation",
    operations: [...read("reconciliations"), "reconciliations.create"],
  },
  {
    module: "Hospitality",
    entity: "Lodging, catering, travel and amenity fulfillment",
    operations: crud("fulfillments"),
  },
  { module: "Hospitality", entity: "BEOs", operations: [...crud("beos"), ...crud("beoLines")] },
  {
    module: "Assets",
    entity: "Assets at class, unit and lot grain",
    operations: [...crud("assetClasses"), ...crud("assetUnits"), ...crud("assetLots")],
  },
  {
    module: "Assets",
    entity: "Custody",
    operations: [...read("assetCustodyEntries"), "assetCustodyEntries.create"],
  },
  { module: "Assets", entity: "Maintenance", operations: crud("assetMaintenanceEvents") },
  { module: "Assets", entity: "Damage", operations: crud("assetDamageReports") },
  {
    module: "Opportunities",
    entity: "Requisitions turned into opportunities",
    operations: [...crud("opportunities"), "opportunities.transition"],
  },
  {
    module: "Opportunities",
    entity: "Applications",
    operations: [...read("applications"), "applications.create", "applications.transition"],
  },
  {
    module: "Opportunities",
    entity: "Selection",
    operations: [...crud("shortlistEntries"), ...crud("interviews"), ...read("bids")],
  },
  { module: "Opportunities", entity: "Offers", operations: [...crud("offers"), "offers.accept"] },
  {
    module: "Opportunities",
    entity: "Onboarding",
    operations: [
      ...crud("onboardingRequirements"),
      ...read("onboardingItems"),
      "onboardingVerifications.create",
    ],
  },
  {
    module: "Opportunities",
    entity: "External engagements",
    operations: [...read("engagements"), "engagements.transition"],
  },
  {
    module: "Opportunities",
    entity: "Ratings",
    operations: [...read("ratings"), "ratings.create"],
  },
  {
    module: "Opportunities",
    entity: "Talent and vendor pools",
    operations: [...crud("talentPools"), ...crud("poolMembers")],
  },
  {
    module: "People",
    entity: "Parties",
    operations: [...read("people"), ...read("organizations"), ...crud("organizationRelationships")],
  },
  {
    module: "People",
    entity: "Roles (61 workforce roles with staffing ratios)",
    operations: [...read("canonRoles"), ...crud("roleAssignments")],
  },
  { module: "People", entity: "Requisitions", operations: crud("requisitions") },
  {
    module: "People",
    entity: "Agreements",
    operations: [...crud("agreements"), "agreements.sign"],
  },
  { module: "Crew", entity: "Shifts", operations: crud("shifts") },
  { module: "Crew", entity: "Swaps", operations: [...read("shiftSwaps"), "shiftSwaps.approve"] },
  {
    module: "Crew",
    entity: "Time entries",
    operations: [...read("timeEntries"), "timeEntries.clockIn", "timeEntries.clockOut"],
  },
  {
    module: "Crew",
    entity: "Timesheets",
    operations: [...read("timesheets"), "timesheets.submit", "timesheets.approve"],
  },
  {
    module: "Crew",
    entity: "Rate cards",
    operations: [...crud("rateCards"), ...crud("rateCardLines")],
  },
  {
    module: "Crew",
    entity: "Pay rate ledger",
    operations: [...read("payRates"), "payRates.create"],
  },
  {
    module: "Crew",
    entity: "Payroll export",
    operations: [...read("payrollRuns"), "payrollExports.create"],
  },
  {
    module: "Credentials",
    entity: "Credential categories",
    operations: crud("credentialCategories"),
  },
  {
    module: "Credentials",
    entity: "Issuance",
    operations: [...read("credentials"), "credentials.create", "credentials.revoke"],
  },
  {
    module: "Credentials",
    entity: "Zone by category access matrix",
    operations: crud("accessGridEntries"),
  },
  {
    module: "Credentials",
    entity: "Scans",
    operations: [...read("accessScans"), "accessScans.create"],
  },
  {
    module: "Finance",
    entity: "Budget lines",
    operations: [...crud("budgets"), ...crud("budgetLines"), "budgets.summary"],
  },
  { module: "Finance", entity: "Expenses", operations: [...crud("expenses"), "expenses.approve"] },
  {
    module: "Finance",
    entity: "Change orders",
    operations: [...crud("changeOrders"), "changeOrders.approve"],
  },
  {
    module: "Finance",
    entity: "Ledger",
    operations: [...crud("journalEntries"), "journalEntries.post"],
  },
  {
    module: "Finance",
    entity: "Periods",
    operations: [...read("accountingPeriods"), "accountingPeriods.transition"],
  },
  {
    module: "Finance",
    entity: "UPL export",
    operations: [...read("postingLines"), "postingLines.export"],
  },
  {
    module: "Finance",
    entity: "GL accounts and cost centers",
    operations: [...read("canonGlAccounts"), ...crud("costCenters")],
  },
  { module: "Procurement", entity: "RFQs", operations: [...crud("rfqs"), "rfqs.issue"] },
  {
    module: "Procurement",
    entity: "POs",
    operations: [...crud("purchaseOrders"), ...crud("poLines"), "purchaseOrders.approve"],
  },
  {
    module: "Procurement",
    entity: "Receipts",
    operations: [...read("goodsReceipts"), "goodsReceipts.create"],
  },
  {
    module: "Procurement",
    entity: "Three-way match",
    operations: [...read("invoiceMatches"), "invoiceMatches.create"],
  },
  {
    module: "Procurement",
    entity: "Catalog (1,211 items)",
    operations: [...read("canonElements"), ...crud("catalogBindings")],
  },
  { module: "Vendors", entity: "Vendors", operations: crud("vendors") },
  { module: "Vendors", entity: "Classes", operations: crud("vendorClasses") },
  { module: "Vendors", entity: "Prequalification", operations: crud("prequalifications") },
  { module: "Vendors", entity: "COIs", operations: crud("insuranceCertificates") },
  { module: "Vendors", entity: "Scorecards", operations: crud("vendorScorecards") },
  { module: "Vendors", entity: "Sponsor entitlements", operations: crud("sponsorEntitlements") },
  {
    module: "Safety",
    entity: "Inspections",
    operations: [...crud("inspections"), ...crud("inspectionTemplates"), "inspections.signOff"],
  },
  {
    module: "Safety",
    entity: "Permit engine",
    operations: [...read("permitRequirements"), "permitRequirements.generate"],
  },
  {
    module: "Safety",
    entity: "Incidents with dispatch",
    operations: [...crud("incidents"), ...crud("dispatchAssignments")],
  },
  { module: "Safety", entity: "Emergency codes", operations: crud("emergencyCodes") },
  { module: "Safety", entity: "Radio plan", operations: crud("radioChannels") },
  {
    module: "Canon",
    entity: "Read-only canon browser",
    operations: [
      ...read("canonDepartments"),
      ...read("canonDisciplines"),
      ...read("canonCategories"),
      ...read("canonTeams"),
      ...read("canonCounterpartyTypes"),
      "canonStdEnumerations.list",
    ],
  },
  {
    module: "Canon",
    entity: "Tenant extensions in .50 to .99",
    operations: ["canonExtensions.propose"],
  },
  { module: "Reports", entity: "Gate readiness", operations: ["reports.gateReadiness"] },
  {
    module: "Reports",
    entity: "Coordinate matrix (90 coordinates)",
    operations: ["canonCoordinateMatrix.list"],
  },
  { module: "Reports", entity: "Budget versus actual", operations: ["reports.budgetVsActual"] },
  {
    module: "Reports",
    entity: "Labor, POs, incidents",
    operations: ["reports.laborCost", "reports.poExposure", "reports.incidentRates"],
  },
  { module: "Reports", entity: "Final cost report", operations: ["reports.finalCostReport"] },
  {
    module: "Settings",
    entity: "Org",
    operations: ["organizations.get", "organizations.update", ...crud("orgBrandings")],
  },
  { module: "Settings", entity: "Members", operations: crud("memberships") },
  { module: "Settings", entity: "Roles", operations: [...crud("roles"), "capabilities.list"] },
  {
    module: "Settings",
    entity: "Security",
    operations: [
      ...crud("orgIpAllowlistEntries"),
      ...crud("verifiedDomains"),
      "breakGlassSessions.create",
    ],
  },
  { module: "Settings", entity: "White label", operations: crud("orgBrandings") },
  {
    module: "Settings",
    entity: "Integrations",
    operations: [...crud("integrations"), ...crud("webhookEndpoints"), ...crud("apiKeys")],
  },
  { module: "Settings", entity: "Billing", operations: [...read("subscriptions"), "plans.list"] },
  {
    module: "Settings",
    entity: "Data and privacy",
    operations: [...read("dsarRequests"), "orgExports.create", "consentRecords.create"],
  },

  // Section 4.4 Gateway
  {
    module: "Gateway",
    entity: "Opportunity marketplace",
    operations: ["marketplace.search", ...crud("savedSearches")],
  },
  {
    module: "Gateway",
    entity: "Consent to share",
    operations: [...read("profileShares"), "profileShares.create", "profileShares.revoke"],
  },
  {
    module: "Gateway",
    entity: "Representation",
    operations: [...crud("representations"), "representations.accept"],
  },
  {
    module: "Gateway",
    entity: "External accounts",
    operations: [...crud("accountMemberships"), "accountMembershipRoles.create"],
  },
  {
    module: "Gateway",
    entity: "Sealed bids",
    operations: [...crud("bids"), ...crud("bidLines"), "bids.unseal"],
  },
  { module: "Gateway", entity: "Agency slates", operations: read("agencySlates") },
  {
    module: "Gateway",
    entity: "Tax identifiers and payouts",
    operations: [...read("taxForms"), ...read("payoutAccounts")],
  },
  { module: "Gateway", entity: "Background checks", operations: read("backgroundChecks") },
  {
    module: "Gateway",
    entity: "Abuse reports",
    operations: [...read("listingReports"), "moderationActions.create"],
  },
  {
    module: "Gateway",
    entity: "Availability",
    operations: [...crud("availabilityCalendars"), ...crud("availabilityBlocks")],
  },
  {
    module: "Gateway",
    entity: "Engagement messaging",
    operations: [...read("engagementThreads"), "engagementMessages.create"],
  },
  {
    module: "Gateway",
    entity: "Invoices and payments",
    operations: [...read("invoices"), ...read("paymentApplications")],
  },
  { module: "Gateway", entity: "Rating replies", operations: ["ratingReplies.create"] },

  // Section 4.8 Identity
  { module: "Identity", entity: "Person", operations: ["me.get", "people.get", "people.update"] },
  { module: "Identity", entity: "Organization", operations: crud("organizations") },
  { module: "Identity", entity: "Subscription", operations: ["subscriptions.get"] },
  {
    module: "Identity",
    entity: "Membership",
    operations: [...crud("memberships"), ...read("membershipRoles"), "memberships.offboard"],
  },
  { module: "Identity", entity: "Engagement", operations: read("engagements") },
  {
    module: "Identity",
    entity: "Project Assignment",
    operations: [...crud("projectAssignments"), "projectAssignmentRoles.create"],
  },
  { module: "Identity", entity: "Account Membership", operations: crud("accountMemberships") },
  {
    module: "Identity",
    entity: "Organization Relationship",
    operations: crud("organizationRelationships"),
  },
  { module: "Identity", entity: "Representation", operations: crud("representations") },
  {
    module: "Identity",
    entity: "Ways to join",
    operations: [
      "joinRequests.create",
      "invitationLinks.create",
      "invites.create",
      "verifiedDomains.create",
    ],
  },
  { module: "Identity", entity: "Offboarding", operations: read("offboardingChecklists") },
  {
    module: "Identity",
    entity: "Profile pages",
    operations: [
      ...crud("personProfiles"),
      ...crud("organizationProfiles"),
      ...crud("profileSections"),
    ],
  },
  {
    module: "Identity",
    entity: "Profile visibility and handles",
    operations: [...crud("profileVisibilityRules"), ...crud("profileHandles")],
  },
  { module: "Identity", entity: "Verification badges", operations: read("verifications") },

  // Section 7.2 canon read endpoints named in Section 10.1
  { module: "Canon", entity: "/canon/departments", operations: read("canonDepartments") },
  { module: "Canon", entity: "/canon/disciplines", operations: read("canonDisciplines") },
  { module: "Canon", entity: "/canon/categories", operations: read("canonCategories") },
  {
    module: "Canon",
    entity: "/canon/elements",
    operations: [...read("canonElements"), "canonElements.resolve"],
  },
  { module: "Canon", entity: "/canon/phases", operations: read("canonPhases") },
  { module: "Canon", entity: "/canon/gate-criteria", operations: read("canonGateCriteria") },
  { module: "Canon", entity: "/canon/record-kinds", operations: read("canonRecordKinds") },
  {
    module: "Canon",
    entity: "Every other dimension",
    operations: [
      ...read("canonActs"),
      ...read("canonTiers"),
      ...read("canonTags"),
      ...read("canonTouchpoints"),
      ...read("canonJurisdictions"),
      ...read("canonRegions"),
      ...read("canonRegionMultipliers"),
      ...read("canonEscalationIndices"),
      ...read("canonStalenessPolicies"),
      ...read("canonPermitRules"),
      ...read("canonMetrics"),
      ...read("canonIdentifierClasses"),
      ...read("canonGrains"),
      ...read("canonProvenances"),
      ...read("canonFacets"),
      ...read("canonAssertionRanks"),
      ...read("canonRecordSubtypes"),
      ...read("canonRecordStates"),
      ...read("canonCostCenterTemplates"),
      ...read("canonCategoryGl"),
      ...read("canonUnitAliases"),
      ...read("canonUnitDimensions"),
      ...read("canonUrnNamespaces"),
      ...read("canonLocales"),
    ],
  },
  {
    module: "Canon",
    entity: "Catalog bridges and price bands",
    operations: [
      "canonElementPriceBands.list",
      ...read("canonElementGtins"),
      "canonElementGtins.resolve",
      "canonElementPhases.list",
      "canonElementTags.list",
      "canonElementPermits.list",
      "canonElementMetrics.list",
      "canonTouchpointDisciplines.list",
      "canonDisciplineTeams.list",
    ],
  },
  {
    module: "Canon",
    entity: "Standard Library",
    operations: [
      "canonStdDocumentLibrary.list",
      "canonStdEmergencyCodes.list",
      "canonStdEnumerations.list",
      "canonStdLaborRateCards.list",
      "canonStdRadioChannels.list",
      "canonStdRoles.list",
      "canonStdSops.list",
      "canonStdVendorClasses.list",
      "canonStdVendorEntitlements.list",
      "canonStdVerbiage.list",
    ],
  },
  {
    module: "Canon",
    entity: "Governance and views",
    operations: [
      ...read("canonProductionTemplates"),
      ...read("canonSupersessions"),
      ...read("canonRatifications"),
      ...read("canonVersions"),
      "canonIntake.create",
      "canonPhaseCoverage.list",
      "canonElementEconomics.list",
      "canonCrosswalkCoverage.list",
      "canonUrns.resolve",
    ],
  },
];
