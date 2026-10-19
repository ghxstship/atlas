/**
 * The A52 part of the Settings module (RRR-97, ADR 0032 amendment): the settings features A50 retired
 * because nothing stored or enforced them (correction `settings-features-not-built`) are built in
 * migrations 1200 to 1205, so their operations return to v1. These corrections fit each frozen shape
 * to its table; catalog/modules/settings.ts spreads them beside the module's other corrections.
 */
import { z } from "@hono/zod-openapi";
import { ProjectRole, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import type { CorrectionInput } from "../../corrections.ts";
import { all, editShape, orNull, setTable } from "../../correct.ts";
import { itemAction } from "../../define.ts";
import type { ActionSpec } from "../../types.ts";

const SINCE = "1.0.0-draft.2";

const serverInstant = (description: string) => ({ schema: fields.instant(description) });
const serverNullableInstant = (description: string) => ({
  schema: orNull(fields.instant(description)),
});

export const a52SettingsCorrections: readonly CorrectionInput[] = [
  {
    id: "org-legal-entity-columns",
    since: SINCE,
    resources: ["orgLegalEntities"],
    change:
      "`country` becomes `country_code`; adds `is_primary` (optional on create, updatable) and the server-set `tax_identifier_last4`. `tax_identifier` is written through the encrypting RPC and read unmasked only with data.restricted.read.tax.",
    reason:
      "app.org_legal_entities (1200) stores the country as `country_code`, marks one live entity per org primary, and keeps the Restricted tax identifier encrypted under a Vault key: it is written only through app.set_org_legal_entity_tax_identifier and read through app.org_legal_entities_masked, which shows its last four to every reader. Reads come from that view; writes go to the table.",
    apply: all(
      setTable("app.org_legal_entities_masked"),
      editShape({
        rename: { country: "country_code" },
        add: {
          is_primary: {
            schema: fields.bool(
              "True for the org's primary entity, printed on generated documents. The first entity is primary; marking another moves the mark.",
              true,
            ),
            create: "optional",
          },
          tax_identifier_last4: {
            schema: orNull(fields.code("Last four characters of the tax identifier.", "6789")),
          },
        },
      }),
    ),
  },
  {
    id: "ip-allowlist-cidr-fixed",
    since: SINCE,
    resources: ["orgIpAllowlistEntries"],
    change:
      "`cidr` is set on create and never changed: the update body carries `label` only. The allow-list is enforced only while the org's `security.ip_allowlist` setting is on.",
    reason:
      "app.org_ip_allowlist (1201) grants callers no update of `cidr` (a changed network is a new entry, so the audit trail shows what was allowed when), and enforcement is switched by the Boolean setting security.ip_allowlist, off by default, so listing a network never locks anyone out by itself.",
    apply: editShape({ immutable: ["cidr"] }),
  },
  {
    id: "access-review-campaign-window",
    since: SINCE,
    resources: ["accessReviewCampaigns"],
    change:
      "Adds the server-set `opened_at` and `closed_at`; `auto_remove_unreviewed` is optional on create (false). Deleting an Active campaign cancels it.",
    reason:
      "app.access_review_campaigns (1202) opens each campaign Active with one item per live role assignment, counts the grace period (access_reviews.grace_days) from `opened_at`, closes it when every item is decided or when it is deleted, and defaults auto_remove_unreviewed to false.",
    apply: editShape({
      optionalOnCreate: ["auto_remove_unreviewed"],
      add: {
        opened_at: serverInstant("When the campaign opened and its items were taken."),
        closed_at: serverNullableInstant(
          "When the campaign completed or was canceled; null while Active.",
        ),
      },
    }),
  },
  {
    id: "access-review-item-decision",
    since: SINCE,
    resources: ["accessReviewItems"],
    change:
      "`decision` accepts Confirmed or Removed, once; adds the server-set `decided_by`, `decided_at` and `flagged_at`.",
    reason:
      "app.access_review_items (1202) records each decision once, with the reviewer and time from the session; Removed ends the role assignment at once. A reviewer never decides their own access or a role above their band (sod_self_review, role_band), and the nightly sweep flags items left unreviewed past the grace period.",
    apply: editShape({
      add: {
        decision: {
          schema: orNull(
            z.enum(["Confirmed", "Removed"]).meta({
              description:
                "Confirmed keeps the role; Removed ends it at once. Null while unreviewed; final once set.",
              example: "Confirmed",
            }),
          ),
          create: "optional",
        },
        decided_by: { schema: orNull(fields.ref("reviewer; null for an automatic removal")) },
        decided_at: serverNullableInstant("When the decision was recorded."),
        flagged_at: serverNullableInstant(
          "When the item was flagged as unreviewed after the grace period.",
        ),
      },
    }),
  },
  {
    id: "break-glass-session-end",
    since: SINCE,
    resources: ["breakGlassSessions"],
    change:
      "Adds the server-set `ended_at`. Creating a session needs a second-factor session (aal2) and a reason of at least 20 characters.",
    reason:
      "app.break_glass_sessions (1203) is written only by app.start_break_glass, which checks org.break_glass.use, aal2, the reason and that no session is open, and by app.end_break_glass, which records when the holder ended it early.",
    apply: editShape({
      add: {
        reason: {
          schema: z.string().min(20).max(2000).meta({
            description: "Written reason, 20 to 2000 characters.",
            example: "Payroll export failed during show day and must run now.",
          }),
          create: "required",
          update: false,
        },
        ended_at: serverNullableInstant(
          "When the holder ended it early; null when it ran its hour.",
        ),
      },
    }),
  },
  {
    id: "project-share-role-and-scope",
    since: SINCE,
    resources: ["projectShares"],
    change:
      "Adds `project_role` (optional on create, Coordinator by default), `scope_node_ids` (the shared scope nodes; empty shares the whole tree) and the server-set `valid_from`. Deleting a share revokes it.",
    reason:
      "app.project_shares (1205) maps the partner's members onto one project role and starts at the moment of sharing; app.project_share_scope_nodes lists the scope nodes a share opens (Section 8.5).",
    apply: editShape({
      add: {
        project_role: { schema: ProjectRole, create: "optional" },
        scope_node_ids: {
          schema: z.array(fields.uuid("Shared scope node.")).max(200).meta({
            description:
              "Scope nodes the share opens, with everything under them; empty shares the whole scope tree.",
          }),
          create: "optional",
        },
        valid_from: serverInstant("When the share started."),
      },
    }),
  },
];

export const a52SettingsActions: Readonly<Record<string, readonly ActionSpec[]>> = {
  breakGlassSessions: [
    itemAction("end", {
      summary: "End emergency access",
      description:
        "Ends the caller's own open break-glass session before its hour is up, through `app.end_break_glass`. Another person's session is refused with 403; one that already ended with 422.",
      rpc: "app.end_break_glass",
    }),
  ],
};

export const a52SettingsCapabilities: Readonly<Record<string, CapabilityRule>> = {
  breakGlassSessions: { actions: { end: "org.break_glass.use" } },
};
