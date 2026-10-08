/**
 * Identity (Section 4.8), Settings and Reports (Section 4.2) and Platform services
 * (Sections 4.6 and 4.10).
 */
import { z } from "@hono/zod-openapi";
import { identity as id, platform as pf } from "@xos/resource-schemas";
import { collectionAction, collectionQuery, itemAction, resource } from "./define.ts";
import type { ResourceSpec } from "./types.ts";

const reportQuery = (verb: string, summary: string, description: string) =>
  collectionQuery(verb, { summary, description, paged: true, response: pf.ReportRow.read });

export const platformResources: readonly ResourceSpec[] = [
  // Identity
  resource("Identity", "/me", id.Me, {
    verbs: [],
    actions: [
      collectionQuery("get", {
        segment: "",
        summary: "Get the caller",
        description:
          "Returns the calling person, their memberships and engagements, and the organization the credential is bound to.",
      }),
    ],
  }),
  resource("Identity", "/people", id.Person, { verbs: ["list", "get", "update"] }),
  resource("Identity", "/organizations", id.Organization, {
    verbs: ["list", "get", "create", "update"],
  }),
  resource("Identity", "/memberships", id.Membership, {
    actions: [
      itemAction("offboard", {
        summary: "Offboard a member",
        description:
          "Ends access at once and opens the offboarding checklist. A sole Owner cannot remove or demote themselves.",
      }),
    ],
  }),
  resource("Identity", "/membership-roles", id.MembershipRole, {
    verbs: ["list", "get", "create", "delete"],
  }),
  resource("Identity", "/project-assignments", id.ProjectAssignment),
  resource("Identity", "/project-assignment-roles", id.ProjectAssignmentRole, {
    verbs: ["list", "get", "create", "delete"],
  }),
  resource("Identity", "/account-memberships", id.AccountMembership),
  resource("Identity", "/account-membership-roles", id.AccountMembershipRole, {
    verbs: ["list", "get", "create", "delete"],
  }),
  resource("Identity", "/organization-relationships", id.OrganizationRelationship),
  resource("Identity", "/representations", id.Representation, {
    actions: [
      itemAction("accept", {
        summary: "Accept a representation",
        description: "Accepts the representation as the represented artist.",
      }),
    ],
  }),
  resource("Identity", "/join-requests", id.JoinRequest, {
    verbs: ["list", "get", "create"],
    actions: [
      itemAction("approve", {
        summary: "Approve a join request",
        description: "Approves the request and creates the membership. Requires an Admin.",
      }),
      itemAction("decline", {
        summary: "Decline a join request",
        description: "Declines the request.",
      }),
    ],
  }),
  resource("Identity", "/invitation-links", id.InvitationLink, {
    verbs: ["list", "get", "create"],
    actions: [
      itemAction("revoke", {
        summary: "Revoke an invitation link",
        description: "Revokes the link; later uses are refused.",
      }),
    ],
  }),
  resource("Identity", "/invites", id.Invite, { verbs: ["list", "get", "create", "delete"] }),
  resource("Identity", "/verified-domains", id.VerifiedDomain, {
    actions: [
      itemAction("verify", {
        summary: "Verify a domain",
        description: "Checks the DNS record and marks the domain verified.",
      }),
    ],
  }),
  resource("Identity", "/offboarding-checklists", id.OffboardingChecklist, {
    verbs: ["list", "get", "update"],
  }),
  resource("Identity", "/person-profiles", id.PersonProfile, {
    verbs: ["list", "get", "create", "update"],
  }),
  resource("Identity", "/organization-profiles", id.OrganizationProfile, {
    verbs: ["list", "get", "create", "update"],
  }),
  resource("Identity", "/profile-sections", id.ProfileSection),
  resource("Identity", "/profile-visibility", id.ProfileVisibilityRule, {
    op: "profileVisibilityRules",
    label: "profile visibility rule",
  }),
  resource("Identity", "/profile-handles", id.ProfileHandle, {
    verbs: ["list", "get", "create", "update"],
  }),
  resource("Identity", "/verifications", id.Verification, { verbs: ["list", "get", "create"] }),
  resource("Identity", "/blocks", id.Block, { verbs: ["list", "get", "create", "delete"] }),

  // Settings
  resource("Settings", "/subscriptions", id.Subscription, { verbs: ["list", "get", "update"] }),
  resource("Settings", "/plans", id.Plan),
  resource("Settings", "/workspaces", pf.Workspace),
  resource("Settings", "/workspace-members", pf.WorkspaceMember, {
    verbs: ["list", "get", "create", "delete"],
  }),
  resource("Settings", "/teams", pf.Team),
  resource("Settings", "/team-members", pf.TeamMember, {
    verbs: ["list", "get", "create", "delete"],
  }),
  resource("Settings", "/org-branding", pf.OrgBranding, {
    op: "orgBrandings",
    label: "org branding",
  }),
  resource("Settings", "/org-legal-entities", pf.OrgLegalEntity),
  resource("Settings", "/org-ip-allowlist", pf.OrgIpAllowlistEntry, {
    op: "orgIpAllowlistEntries",
    label: "IP allow-list entry",
  }),
  resource("Settings", "/roles", pf.Role),
  resource("Settings", "/capabilities", pf.Capability, {
    order: { by: ["capability"], numeric: false },
  }),
  resource("Settings", "/role-capabilities", pf.RoleCapability, {
    verbs: ["list", "get", "create", "delete"],
  }),
  resource("Settings", "/user-capability-grants", pf.UserCapabilityGrant),
  resource("Settings", "/record-grants", pf.RecordGrant),
  resource("Settings", "/delegations", pf.Delegation),
  resource("Settings", "/spend-authority", pf.SpendAuthority, {
    op: "spendAuthorityLimits",
    label: "spend authority limit",
  }),
  resource("Settings", "/separation-of-duties-rules", pf.SeparationOfDutiesRule),
  resource("Settings", "/column-classifications", pf.ColumnClassification),
  resource("Settings", "/access-review-campaigns", pf.AccessReviewCampaign),
  resource("Settings", "/access-review-items", pf.AccessReviewItem, {
    verbs: ["list", "get", "update"],
  }),
  resource("Settings", "/break-glass-sessions", pf.BreakGlassSession, {
    verbs: ["list", "get", "create"],
  }),
  resource("Settings", "/project-shares", pf.ProjectShare),
  resource("Settings", "/scim-group-mappings", pf.ScimGroupMapping, {
    label: "SCIM group mapping",
  }),
  resource("Settings", "/api-keys", pf.ApiKey, {
    verbs: ["list", "get", "create", "update"],
    label: "API key",
    actions: [
      itemAction("revoke", {
        summary: "Revoke an API key",
        description: "Revokes the key at once. Requires step-up authentication.",
      }),
      itemAction("rotate", {
        summary: "Rotate an API key",
        description: "Issues a new secret and revokes the old one. The secret is shown once.",
        response: pf.ApiKeySecret,
      }),
    ],
  }),
  resource("Settings", "/service-accounts", pf.ServiceAccount),
  resource("Settings", "/oauth-apps", pf.OauthApp, { label: "OAuth app" }),
  resource("Settings", "/oauth-grants", pf.OauthGrant, {
    verbs: ["list", "get", "delete"],
    label: "OAuth grant",
  }),
  resource("Settings", "/integrations", pf.Integration),
  resource("Settings", "/webhook-endpoints", pf.WebhookEndpoint),
  resource("Settings", "/webhook-deliveries", pf.WebhookDelivery, {
    verbs: ["list", "get"],
    actions: [
      itemAction("replay", {
        summary: "Replay a webhook delivery",
        description: "Sends the delivery again with a fresh signature.",
        status: 202,
      }),
    ],
  }),
  resource("Settings", "/webhook-events", pf.WebhookEventType, {
    op: "webhookEventTypes",
    order: { by: ["event"], numeric: false },
  }),
  resource("Settings", "/setting-definitions", pf.SettingDefinition, {
    order: { by: ["setting_key"], numeric: false },
  }),
  resource("Settings", "/setting-values", pf.SettingValue),
  resource("Settings", "/setting-locks", pf.SettingLock, {
    verbs: ["list", "get", "create", "delete"],
  }),
  resource("Settings", "/audit-events", pf.AuditEvent, {
    verbs: ["list", "get"],
    order: { by: ["occurred_at"], numeric: false },
  }),
  resource("Settings", "/consent-records", pf.ConsentRecord, { verbs: ["list", "get", "create"] }),
  resource("Settings", "/dsar-requests", pf.DsarRequest, {
    verbs: ["list", "get", "create"],
    label: "DSAR request",
  }),
  resource("Settings", "/retention-policies", pf.RetentionPolicy),
  resource("Settings", "/org-exports", pf.OrgExport, { verbs: ["list", "get", "create"] }),
  resource("Settings", "/ai-settings", pf.AiSettings, {
    op: "aiSettings",
    verbs: ["list", "get", "update"],
    label: "AI settings",
  }),

  // Reports
  resource("Reports", "/report-definitions", pf.ReportDefinition),
  resource("Reports", "/report-runs", pf.ReportRun, { verbs: ["list", "get", "create"] }),
  resource("Reports", "/report-schedules", pf.ReportSchedule),
  resource("Reports", "/dashboards", pf.Dashboard),
  resource("Reports", "/dashboard-tiles", pf.DashboardTile),
  resource("Reports", "/reports", pf.ReportRow, {
    verbs: [],
    actions: [
      reportQuery(
        "budgetVsActual",
        "Budget versus actual",
        "Budget versus actual by GL account, cost center and URID. Aggregates of unpriced lines stay null and carry `unpriced_count`.",
      ),
      reportQuery(
        "laborCost",
        "Labor cost",
        "Labor cost by role and department from approved timesheets. Restricted pay columns are masked without the capability.",
      ),
      reportQuery(
        "poExposure",
        "PO exposure",
        "Open purchase order exposure by vendor and GL account.",
      ),
      reportQuery(
        "incidentRates",
        "Incident rates",
        "Incident counts and rates by severity and project.",
      ),
      reportQuery(
        "finalCostReport",
        "Final cost report",
        "Final cost against the gate 3 baseline.",
      ),
      reportQuery(
        "gateReadiness",
        "Gate readiness",
        "Gate readiness across projects, one row per project and gate.",
      ),
    ],
  }),

  // Platform services
  resource("Platform", "/custom-object-types", pf.CustomObjectType),
  resource("Platform", "/custom-object-fields", pf.CustomObjectField),
  resource("Platform", "/objects/{object_key}", pf.CustomObjectRecord, {
    op: "objects",
    label: "custom object record",
  }),
  resource("Platform", "/custom-object-relations", pf.CustomObjectRelation, {
    verbs: ["list", "get", "create", "delete"],
  }),
  resource("Platform", "/custom-field-definitions", pf.CustomFieldDefinition),
  resource("Platform", "/custom-field-values", pf.CustomFieldValue),
  resource("Platform", "/org-state-labels", pf.OrgStateLabel),
  resource("Platform", "/import-jobs", pf.ImportJob, {
    verbs: ["list", "get", "create"],
    actions: [
      itemAction("dryRun", {
        summary: "Dry-run an import",
        description:
          "Validates every row and reports counts of creates, updates, merges and refusals without writing.",
      }),
      itemAction("commit", {
        summary: "Commit an import",
        description: "Writes the validated rows in one import batch.",
        status: 201,
      }),
    ],
  }),
  resource("Platform", "/import-batches", pf.ImportBatch, {
    verbs: ["list", "get"],
    actions: [
      itemAction("undo", {
        summary: "Undo an import batch",
        description:
          "Rolls back the batch within 7 days. Rows a later edit depends on are listed in a refusal instead of deleted.",
      }),
    ],
  }),
  resource("Platform", "/import-row-results", pf.ImportRowResult, {
    verbs: ["list", "get"],
    order: { by: ["source_row"], numeric: false },
  }),
  resource("Platform", "/import-mapping-profiles", pf.ImportMappingProfile),
  resource("Platform", "/merge-reviews", pf.MergeReview, { verbs: ["list", "get", "update"] }),
  resource("Platform", "/export-jobs", pf.ExportJob, { verbs: ["list", "get", "create"] }),
  resource("Platform", "/saved-views", pf.SavedView),
  resource("Platform", "/approval-policies", pf.ApprovalPolicy),
  resource("Platform", "/approval-instances", pf.ApprovalInstance, {
    verbs: ["list", "get", "create"],
  }),
  resource("Platform", "/approval-decisions", pf.ApprovalDecision, {
    verbs: ["list", "get", "create"],
  }),
  resource("Platform", "/comment-threads", pf.CommentThread, {
    verbs: ["list", "get", "create", "update"],
  }),
  resource("Platform", "/comments", pf.Comment),
  resource("Platform", "/notifications", pf.Notification, {
    verbs: ["list", "get", "update"],
    actions: [
      collectionAction("markAllRead", {
        summary: "Mark all notifications read",
        description: "Marks every unread notification of the caller as read.",
        response: z
          .object({ updated_count: z.int().meta({ example: 12 }) })
          .meta({ id: "MarkAllReadResult" }),
      }),
    ],
  }),
  resource("Platform", "/notification-preferences", pf.NotificationPreference, {
    verbs: ["list", "get", "create", "update"],
  }),
  resource("Platform", "/calendar-feeds", pf.CalendarFeed, {
    verbs: ["list", "get", "create", "delete"],
  }),
  resource("Platform", "/trash", pf.TrashItem, {
    op: "trashItems",
    order: { by: ["deleted_at"], numeric: false },
    actions: [
      collectionAction("restore", {
        summary: "Restore a deleted item",
        description: "Restores a soft-deleted row within its retention period.",
        body: z
          .object({
            subject_urn: z
              .string()
              .min(1)
              .meta({ example: "urn:xpms:record:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f" }),
          })
          .meta({ id: "RestoreRequest" }),
      }),
    ],
  }),
  resource("Platform", "/templates", pf.Template),
  resource("Platform", "/template-applications", pf.TemplateApplication, {
    verbs: ["list", "get", "create"],
  }),
];
