/**
 * Showcaller links (B3, ADR 0142, migrations 2923 to 2925): a no-account link and 6-digit access code that let an
 * outside showcaller call one running order and edit it live, within that running order only. The token and the
 * code are answered once and stored only as hashes. catalog/modules/show.ts spreads these into the Show additions.
 * The anonymous open, read and writes are not API operations: they are the api_public.open_showcaller_link,
 * showcaller_run and showcaller_* token RPCs, which the Atlas portal calls (as ADR 0130 decision 9 keeps P1's).
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import { editDefinition, orNull } from "../../correct.ts";
import { collectionAction, itemAction, resource } from "../../define.ts";
import type { ResourceSpec } from "../../types.ts";

const ShowcallerLink = editDefinition(
  defineResource({
    name: "ShowcallerLink",
    table: "app.showcaller_links",
    description:
      "A no-account link and access code that let an outside showcaller call one running order and edit it live, within that running order only (ADR 0142). Every link expires within 14 days and serves at most 5 devices; the token and the code are returned once by `showcallerLinks.create` or `showcallerLinks.regenerate` and stored only as hashes, so they never appear here. Members read the links of running orders they can read.",
    serverSet: [
      "project_id",
      "run_of_show_id",
      "caller_name",
      "note",
      "token_hint",
      "expires_at",
      "failed_attempts",
      "open_count",
      "last_opened_at",
      "rotated_at",
      "revoked_at",
      "revoked_by",
    ],
    fields: {
      project_id: fields.ref("project of the running order, stamped by the database"),
      run_of_show_id: fields.ref("running order the link calls"),
      caller_name: fields.text(
        "Name of the showcaller the link is for, shown beside each cue called through it.",
        "Sam Okafor",
        120,
      ),
      note: orNull(
        fields.text(
          "What the link is for. Never shown on the portal.",
          "Night one guest caller",
          200,
        ),
      ),
      token_hint: fields.text("Last four characters of the token, to tell links apart.", "3f9a", 4),
      expires_at: fields.instant("When the link stops opening and writing: within 14 days."),
      failed_attempts: fields.int(
        "Wrong access codes since the link was made or regenerated; it locks at 5, and devices that proved the code keep working.",
        0,
      ),
      open_count: fields.int("Successful opens with the access code.", 2),
      last_opened_at: orNull(fields.instant("When the link was last opened.")),
      rotated_at: orNull(fields.instant("When the link was last regenerated.")),
      revoked_at: orNull(fields.instant("When the link was revoked; it never opens again.")),
      revoked_by: orNull(fields.ref("person who revoked the link")),
    },
  }),
  // Opening a link counts on the row without a person, so the last updater can be nobody.
  { nullable: ["created_by", "updated_by"] },
);

const token = z
  .string()
  .regex(/^xscl_[0-9a-f]{64}$/)
  .meta({
    description:
      "The link token. The portal is `{Atlas origin}/share/showcaller/{token}`. Shown once; only its hash is stored.",
    example: `xscl_${"0".repeat(64)}`,
  });

const accessCode = z
  .string()
  .regex(/^[0-9]{6}$/)
  .meta({
    description: "The 6-digit access code. Shown once; send it apart from the link.",
    example: "042424",
  });

const ShowcallerLinkToken = z
  .object({
    showcaller_link_id: fields.uuid("The new link."),
    token,
    access_code: accessCode,
    expires_at: fields.instant("When the link stops opening."),
  })
  .meta({
    id: "ShowcallerLinkToken",
    description: "A new showcaller link with its token and access code, shown once.",
  });

const ShowcallerLinkRegenerated = z
  .object({
    token,
    access_code: accessCode,
    expires_at: fields.instant("When the link stops opening; regenerating keeps the expiry."),
  })
  .meta({
    id: "ShowcallerLinkRegenerated",
    description: "A regenerated showcaller link's new token and access code, shown once.",
  });

const DevicesSignedOut = z
  .object({ devices: fields.int("How many devices were signed out.", 2) })
  .meta({ id: "ShowcallerDevicesSignedOut", description: "How many device grants were dropped." });

export const showcallerLinkResources: readonly ResourceSpec[] = [
  resource("Show", "/showcaller-links", ShowcallerLink, {
    verbs: ["list", "get"],
    actions: [
      collectionAction("create", {
        segment: "create",
        summary: "Create a showcaller link to a running order",
        description:
          "Makes a showcaller link through app.create_showcaller_link. The caller must be a member of the running order's org and hold both show.run_of_show.write and show.cue.call on the project (422 `showcaller_link_capability`); a read-only org makes none (422 `org_read_only`). `caller_name` is 1 to 120 characters (422 `showcaller_link_caller_name`). `expires_at` defaults to the end of the day after the show in the project's zone; when given it must be after now and within 14 days (422 `showcaller_link_expiry_range`). A running order holds at most 5 live links (422 `showcaller_link_limit`). Anyone with the link and the code can call cues and edit this running order until it expires. Answers 201 with the token and code, shown once.",
        body: z
          .object({
            run_of_show_id: fields.ref("running order the link calls"),
            caller_name: fields.text("Name of the showcaller.", "Sam Okafor", 120),
            expires_at: fields
              .instant("When the link stops opening; by default the end of the day after the show.")
              .optional(),
            note: fields
              .text(
                "What the link is for. Never shown on the portal.",
                "Night one guest caller",
                200,
              )
              .optional(),
          })
          .meta({
            id: "ShowcallerLinkRequest",
            description: "A showcaller link to a running order.",
          }),
        response: ShowcallerLinkToken,
        rpc: "create_showcaller_link",
        status: 201,
      }),
      itemAction("regenerate", {
        summary: "Regenerate a showcaller link",
        description:
          "Draws a new token and access code through app.regenerate_showcaller_link: the old address answers that the link is no longer available, wrong-code attempts reset and every device must enter the new code. Its creator, or a holder of show.run_of_show.write on the project, may. A revoked link (422 `showcaller_link_revoked`) and a read-only org (422 `org_read_only`) are refused. Answers the new token and code, shown once.",
        response: ShowcallerLinkRegenerated,
        rpc: "regenerate_showcaller_link",
      }),
      itemAction("revoke", {
        summary: "Revoke a showcaller link",
        description:
          "Revokes the link through app.revoke_showcaller_link so it never opens or writes again and the open portal stops on its next update. Its creator, or a holder of show.run_of_show.write on the project, may, also in a read-only org. Revoking a revoked link answers it unchanged.",
        response: ShowcallerLink.read,
        rpc: "revoke_showcaller_link",
      }),
      itemAction("signOutDevices", {
        segment: "sign-out-devices",
        summary: "Sign every device out of a showcaller link",
        description:
          "Drops every device grant of the link through app.sign_out_showcaller_devices, so each device must enter the access code again; the token and code stay. Its creator, or a holder of show.run_of_show.write on the project, may. Answers how many devices were signed out.",
        response: DevicesSignedOut,
        rpc: "sign_out_showcaller_devices",
      }),
    ],
  }),
];

/** Reading needs show.run_of_show.read; the database enforces who may make and manage a link. */
export const showcallerLinkCapabilities: Readonly<Record<string, CapabilityRule>> = {
  showcallerLinks: {
    read: "show.run_of_show.read",
    actions: {
      create: "show.run_of_show.read",
      regenerate: "show.run_of_show.read",
      revoke: "show.run_of_show.read",
      signOutDevices: "show.run_of_show.read",
    },
  },
};
