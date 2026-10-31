/**
 * Live links (P1, ADR 0130, migrations 2780 to 2782): no-account links to one saved view of a
 * project, or to one running order on a display screen (room clock, presenter timer, backstage),
 * that update while they are open. Every link has an expiry within 90 days and a 6-digit access
 * code (Section 7.5 invariant 8, ADR 0033 decision 56); the token and the code are answered once
 * and stored only as hashes. catalog/modules/platform.ts spreads these into the Platform additions.
 * The anonymous open and reads are not API operations: they are the api_public.open_live_link,
 * live_view and live_display token RPCs, which the Atlas public pages call.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import { editDefinition, orNull } from "../../correct.ts";
import { collectionAction, itemAction, resource } from "../../define.ts";
import type { ResourceSpec } from "../../types.ts";

const LinkKind = z.enum(["View", "Display"]).meta({
  description: "View, a saved view; Display, a running order on a screen.",
  example: "View",
});

const DisplayMode = z.enum(["Room Clock", "Presenter Timer", "Backstage"]).meta({
  description: "Mode a display screen opens in.",
  example: "Backstage",
});

const LiveLink = editDefinition(
  defineResource({
    name: "LiveLink",
    table: "app.live_links",
    description:
      "A no-account link to one saved view of a project, or to one running order on a display screen, that updates while it is open (ADR 0130). Every link expires within 90 days and asks for a 6-digit access code; the token and the code are returned once by `liveLinks.createView`, `liveLinks.createDisplay` or `liveLinks.regenerate` and stored only as hashes, so they never appear here. Members read the links of projects where they hold the collection's read capability (show.run_of_show.read for display screens).",
    serverSet: [
      "project_id",
      "link_kind",
      "saved_view_id",
      "run_of_show_id",
      "default_mode",
      "token_hint",
      "note",
      "expires_at",
      "failed_attempts",
      "open_count",
      "last_opened_at",
      "rotated_at",
      "revoked_at",
      "revoked_by",
    ],
    fields: {
      project_id: fields.ref("project the link shows"),
      link_kind: LinkKind,
      saved_view_id: orNull(fields.uuid("Saved view a View link shows.")),
      run_of_show_id: orNull(fields.uuid("Running order a Display link shows.")),
      default_mode: orNull(DisplayMode),
      token_hint: fields.text("Last four characters of the token, to tell links apart.", "3f9a", 4),
      note: orNull(
        fields.text("What the link is for. Never shown on the public page.", "Venue screens", 200),
      ),
      expires_at: fields.instant(
        "When the link stops opening: within 90 days of when it was made.",
      ),
      failed_attempts: fields.int(
        "Wrong access codes since the link was made or regenerated; it locks at 5.",
        0,
      ),
      open_count: fields.int("Successful opens with the access code.", 3),
      last_opened_at: orNull(fields.instant("When the link was last opened.")),
      rotated_at: orNull(fields.instant("When the link was last regenerated.")),
      revoked_at: orNull(fields.instant("When the link was revoked; it never opens again.")),
      revoked_by: orNull(fields.ref("person who revoked the link")),
    },
  }),
  // Opening a link counts on the row without a person, so the last updater can be nobody.
  { nullable: ["created_by", "updated_by"] },
);

const tokenField = (prefix: "xshv" | "xscr" | "either") =>
  z
    .string()
    .regex(
      prefix === "either" ? /^xs(hv|cr)_[0-9a-f]{64}$/ : new RegExp(`^${prefix}_[0-9a-f]{64}$`),
    )
    .meta({
      description:
        "The link token. A saved view link is `{Atlas origin}/share/view/{token}` (xshv_), a display screen `{Atlas origin}/share/screen/{token}` (xscr_). Shown once; only its hash is stored.",
      example: `${prefix === "xscr" ? "xscr" : "xshv"}_${"0".repeat(64)}`,
    });

const accessCode = z
  .string()
  .regex(/^[0-9]{6}$/)
  .meta({
    description: "The 6-digit access code. Shown once; send it apart from the link.",
    example: "042424",
  });

const LiveLinkToken = (id: string, prefix: "xshv" | "xscr") =>
  z
    .object({
      live_link_id: fields.uuid("The new link."),
      token: tokenField(prefix),
      access_code: accessCode,
      expires_at: fields.instant("When the link stops opening."),
    })
    .meta({ id, description: "A new live link with its token and access code, shown once." });

const LiveLinkRegenerated = z
  .object({
    token: tokenField("either"),
    access_code: accessCode,
    expires_at: fields.instant("When the link stops opening; regenerating keeps the expiry."),
  })
  .meta({
    id: "LiveLinkRegenerated",
    description: "A regenerated live link's new token and access code, shown once.",
  });

const note = fields
  .text("What the link is for. Never shown on the public page.", "Venue screens", 200)
  .optional();

export const liveLinkResources: readonly ResourceSpec[] = [
  resource("Platform", "/live-links", LiveLink, {
    verbs: ["list", "get"],
    actions: [
      collectionAction("createView", {
        segment: "view",
        summary: "Create a live link to a saved view",
        description:
          "Makes a no-account link to a saved view the caller can read, on one project of its org, through app.create_view_link. The caller must be a member of the project's org and hold the collection's share capability on the project (schedule.timeline.export for the Schedule, show.run_of_show.write for running orders, show.day_sheet.write for day sheets; 422 `live_link_capability`). The view's page and every filter, sort and grouping must be ones a live link shows (422 `live_link_view_unsupported`). `expires_at` is required, after now and within 90 days (422 `live_link_expiry`, `live_link_expiry_range`); a view holds at most 20 live links (422 `live_link_limit`); a read-only org makes none (422 `org_read_only`). Every link has an access code. Answers 201 with the token and code, shown once.",
        body: z
          .object({
            saved_view_id: fields.ref("saved view to share"),
            project_id: fields.ref("project the link shows"),
            expires_at: fields.instant(
              "When the link stops opening: after now and within 90 days.",
            ),
            note,
          })
          .meta({ id: "LiveViewLinkRequest", description: "A live link to a saved view." }),
        response: LiveLinkToken("LiveViewLinkToken", "xshv"),
        rpc: "create_view_link",
        status: 201,
      }),
      collectionAction("createDisplay", {
        segment: "display",
        summary: "Create a display screen link to a running order",
        description:
          "Makes a no-account display screen link (room clock, presenter timer, backstage) to a running order through app.create_display_link. The caller must be a member of its org and hold show.run_of_show.write on the project (422 `live_link_capability`). `expires_at` defaults to the end of the day after the show in the project's zone, at most 90 days ahead; when given it must be after now and within 90 days (422 `live_link_expiry_range`). A running order holds at most 20 live links (422 `live_link_limit`); a read-only org makes none (422 `org_read_only`). Answers 201 with the token and code, shown once.",
        body: z
          .object({
            run_of_show_id: fields.ref("running order to show"),
            expires_at: fields
              .instant("When the link stops opening; by default the end of the day after the show.")
              .optional(),
            default_mode: DisplayMode.optional(),
            note,
          })
          .meta({
            id: "LiveDisplayLinkRequest",
            description: "A display screen link to a running order.",
          }),
        response: LiveLinkToken("LiveDisplayLinkToken", "xscr"),
        rpc: "create_display_link",
        status: 201,
      }),
      itemAction("regenerate", {
        summary: "Regenerate a live link",
        description:
          "Draws a new token and access code through app.regenerate_live_link: the old address answers that the link is no longer available, wrong-code attempts reset and every device that opened the link must enter the new code. Its creator, or a holder of the collection's share capability on the project, may. A revoked link (422 `live_link_revoked`) and a read-only org (422 `org_read_only`) are refused. Answers the new token and code, shown once.",
        response: LiveLinkRegenerated,
        rpc: "regenerate_live_link",
      }),
      itemAction("revoke", {
        summary: "Revoke a live link",
        description:
          "Revokes the link through app.revoke_live_link so it never opens again and every open page stops on its next update. Its creator, or a holder of the collection's share capability on the project, may, also in a read-only org. Revoking a revoked link answers it unchanged.",
        response: LiveLink.read,
        rpc: "revoke_live_link",
      }),
    ],
  }),
];

/**
 * Reading and the actions need projects.project.read; the database enforces each collection's share
 * capability (and show.run_of_show.write for display screens) on the project.
 */
export const liveLinkCapabilities: Readonly<Record<string, CapabilityRule>> = {
  liveLinks: {
    read: "projects.project.read",
    actions: {
      createView: "projects.project.read",
      createDisplay: "projects.project.read",
      regenerate: "projects.project.read",
      revoke: "projects.project.read",
    },
  },
};
