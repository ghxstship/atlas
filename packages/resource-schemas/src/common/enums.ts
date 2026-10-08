/**
 * Closed lists whose values the build spec states explicitly. Each one mirrors a Postgres enum
 * owned by a data agent; when the generated database types land, these are checked against them.
 * Values keep the order the spec gives, which is also the lifecycle order.
 */
import { z } from "zod";

/** Refusal outcomes (Section 3.7). */
export const Refusal = z.enum(["NO_ANSWER", "UNRATIFIED", "REFUSE"]).meta({
  id: "Refusal",
  description:
    "Refusal outcome (Section 3.7). NO_ANSWER: the data does not support an answer. UNRATIFIED: the value is proposed and not ratified. REFUSE: a rule forbids the action.",
  example: "REFUSE",
});

/** The nine record states (Section 3.10). */
export const RecordState = z
  .enum([
    "Proposed",
    "Ready",
    "Scheduled",
    "Active",
    "Blocked",
    "In Review",
    "Complete",
    "Deferred",
    "Canceled",
  ])
  .meta({
    id: "RecordState",
    description:
      "Record state (Section 3.10). Blocked names its blocker, Deferred carries a replan reason, Canceled is retained.",
    example: "Scheduled",
  });

/** `opportunity_state` (Section 4.4.4). */
export const OpportunityState = z
  .enum(["Draft", "Pending Approval", "Published", "Paused", "Filled", "Closed", "Canceled"])
  .meta({
    id: "OpportunityState",
    description: "Opportunity lifecycle state.",
    example: "Published",
  });

/** `application_state` (Section 4.4.4). */
export const ApplicationState = z
  .enum([
    "Submitted",
    "In Review",
    "Shortlisted",
    "Offered",
    "Accepted",
    "Declined",
    "Withdrawn",
    "Not Selected",
  ])
  .meta({
    id: "ApplicationState",
    description: "Application lifecycle state.",
    example: "Submitted",
  });

/** `engagement_state` (Section 4.4.4). */
export const EngagementState = z
  .enum(["Onboarding", "Blocked", "Active", "Closing", "Complete", "Canceled"])
  .meta({
    id: "EngagementState",
    description:
      "Engagement lifecycle state. Active requires every blocking onboarding item to pass.",
    example: "Onboarding",
  });

/** Accounting period lifecycle (Section 7.4). */
export const AccountingPeriodState = z
  .enum(["Open", "In Period", "Closing", "Closed", "Audited", "Archived"])
  .meta({
    id: "AccountingPeriodState",
    description: "Accounting period lifecycle. A closed period refuses postings.",
    example: "Open",
  });

/** Import row states (Section 4.6.2). */
export const ImportRowState = z
  .enum(["Valid", "Invalid", "Written", "Refused", "Skipped"])
  .meta({ id: "ImportRowState", description: "Import row result state.", example: "Valid" });

/** Reconciliation results (Section 7.4). */
export const ReconciliationResult = z.enum(["Met", "Gap", "Unknown"]).meta({
  id: "ReconciliationResult",
  description:
    "Requirement against capability result. Unknown against a critical requirement is a gap at gate 3.",
  example: "Met",
});

/** Requirement and capability direction facet (Section 7.4). */
export const Direction = z.enum(["require", "provide"]).meta({
  id: "Direction",
  description: "Require (a requirement) or provide (a capability).",
  example: "require",
});

/** External role types (Section 4.4.2). */
export const ExternalRoleType = z
  .enum([
    "Client",
    "Vendor",
    "Contractor",
    "Crew",
    "Staff",
    "Artist",
    "Artist Representative",
    "Sponsor",
  ])
  .meta({
    id: "ExternalRoleType",
    description: "External role type (Section 4.4.2).",
    example: "Crew",
  });

/** Platform roles per org, in band order (Section 8). */
export const OrgRole = z
  .enum(["Owner", "Admin", "Manager", "Member", "Collaborator", "Field", "Viewer"])
  .meta({
    id: "OrgRole",
    description: "Platform role in band order (Section 8).",
    example: "Manager",
  });

/** Project roles (Section 8). */
export const ProjectRole = z
  .enum(["Producer", "Department Head", "Coordinator", "Field Supervisor", "Field"])
  .meta({ id: "ProjectRole", description: "Project role (Section 8).", example: "Producer" });

/** External account roles (Section 4.4.1). */
export const AccountRole = z
  .enum(["Account Owner", "Account Admin", "Account Finance", "Account Member"])
  .meta({
    id: "AccountRole",
    description: "Role inside an external account.",
    example: "Account Finance",
  });

/** Opportunity visibility (Section 4.4.3). */
export const OpportunityVisibility = z.enum(["Invited", "Pool", "Network", "Public"]).meta({
  id: "OpportunityVisibility",
  description: "Who can see an opportunity.",
  example: "Pool",
});

/** Profile visibility (Section 4.8.3). */
export const ProfileVisibility = z.enum(["Public", "Network", "Private"]).meta({
  id: "ProfileVisibility",
  description:
    "Profile visibility. Sections and fields may be set lower than the profile, never higher.",
  example: "Private",
});

/** Pool membership levels (Section 4.4.3). */
export const PoolLevel = z.enum(["Preferred", "Approved", "Do Not Engage"]).meta({
  id: "PoolLevel",
  description:
    "Talent or vendor pool level. Do Not Engage is internal only and needs a reason and review date.",
  example: "Preferred",
});

/** Compensation rate types (Section 4.4.3). */
export const RateType = z
  .enum(["Hourly", "Day", "Flat", "Milestone", "Bid"])
  .meta({ id: "RateType", description: "Compensation rate type.", example: "Day" });

/** Column classification (Section 8.3). */
export const Classification = z.enum(["Public", "Internal", "Confidential", "Restricted"]).meta({
  id: "Classification",
  description: "Column classification (Section 8.3).",
  example: "Restricted",
});

/** Representation scopes (Section 4.4.1). */
export const RepresentationScope = z.enum(["Offers", "Advance", "Settlement", "Documents"]).meta({
  id: "RepresentationScope",
  description: "Scope a representation delegates.",
  example: "Advance",
});

/** Organization relationship kinds (Section 4.8.1). */
export const OrganizationRelationshipKind = z
  .enum(["Vendor Of", "Client Of", "Partner Of", "Represents"])
  .meta({
    id: "OrganizationRelationshipKind",
    description: "Kind of relationship one organization holds to another.",
    example: "Vendor Of",
  });

/** Hospitality fulfillment kinds (Section 7.4). */
export const FulfillmentKind = z.enum(["Lodging", "Catering", "Travel", "Amenity"]).meta({
  id: "FulfillmentKind",
  description: "Hospitality fulfillment kind.",
  example: "Lodging",
});

/** Spend authority document types (Section 8.1). */
export const SpendDocumentType = z
  .enum([
    "Purchase Order",
    "Change Order",
    "Expense",
    "Invoice Approval",
    "Contract",
    "Payroll Run",
  ])
  .meta({
    id: "SpendDocumentType",
    description: "Document type a spend limit applies to.",
    example: "Purchase Order",
  });

/** Export formats (Section 4.6.4). */
export const ExportFormat = z
  .enum(["CSV", "XLSX", "PDF"])
  .meta({ id: "ExportFormat", description: "Export file format.", example: "CSV" });

/** Setting scopes, most specific first (Section 4.5.6). */
export const SettingScope = z
  .enum(["Personal", "Project", "Team", "Workspace", "Organization", "Platform"])
  .meta({
    id: "SettingScope",
    description: "Scope a setting value applies to, most specific first (Section 4.5.6).",
    example: "Organization",
  });
