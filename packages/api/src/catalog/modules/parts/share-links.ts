/**
 * Share links (A82, migration 1380, Section 8.6, finding A65-016): links that open one version of a
 * file without an account. Public files may have a link without an expiry, Internal links need an
 * expiry, Confidential links need an expiry, an access code and the recipient's email, and
 * Restricted files never get one. catalog/modules/platform.ts spreads these into the Platform
 * additions. The anonymous open is not an API operation: it is the api_public.open_share_link token
 * RPC, which the web shells call.
 */
import { z } from "@hono/zod-openapi";
import { Classification, defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import { editDefinition, orNull } from "../../correct.ts";
import { collectionAction, itemAction, resource } from "../../define.ts";
import type { ResourceSpec } from "../../types.ts";

const ShareLink = editDefinition(
  defineResource({
    name: "ShareLink",
    table: "app.share_links",
    description:
      "A link that opens one clean version of a file without an account (Section 8.6). Public files may have a link without an expiry; Internal links need an expiry within 90 days; Confidential links need an expiry within 30 days, an access code and the recipient's email, which the watermark on every downloaded page carries; Restricted files never get a link. The token and the access code are returned once by `shareLinks.create` and stored only as hashes, so they never appear here. Anyone who can read the file reads its links.",
    serverSet: [
      "attachment_version_id",
      "classification",
      "failed_attempts",
      "open_count",
      "last_opened_at",
      "revoked_at",
      "revoked_by",
    ],
    immutable: ["attachment_id", "access_code_required", "recipient_email", "note", "expires_at"],
    fields: {
      attachment_id: fields.ref("file the link shares"),
      attachment_version_id: orNull(
        fields.uuid("Clean version the link opens, set from the file's current version."),
      ),
      classification: Classification,
      access_code_required: fields.bool(
        "True when the link asks for a 6-digit access code; always true for a Confidential file.",
        false,
      ),
      recipient_email: orNull(
        fields.email("Who the link is for, lowercased. Required for a Confidential file."),
      ),
      note: orNull(fields.text("What the link is for.", "Stage plot for the venue", 200)),
      expires_at: orNull(
        fields.instant(
          "When the link stops opening: within 90 days, 30 for a Confidential file. Null only for a Public file.",
        ),
      ),
      failed_attempts: fields.int("Wrong access codes entered; the link locks at 5.", 0),
      open_count: fields.int("Successful opens.", 2),
      last_opened_at: orNull(fields.instant("When the link was last opened.")),
      revoked_at: orNull(fields.instant("When the link was revoked; it never opens again.")),
      revoked_by: orNull(fields.ref("person who revoked the link")),
    },
  }),
  // An anonymous open counts on the row, so the last updater can be nobody.
  { nullable: ["created_by", "updated_by"], optionalOnCreate: ["access_code_required"] },
);

const ShareLinkToken = z
  .object({
    share_link_id: fields.uuid("The new link."),
    token: z
      .string()
      .regex(/^xshr_[0-9a-f]{64}$/)
      .meta({
        description:
          "The link token. The link is `{Atlas origin}/share/{token}`. Shown once; only its hash is stored.",
        example: `xshr_${"0".repeat(64)}`,
      }),
    access_code: orNull(
      z
        .string()
        .regex(/^[0-9]{6}$/)
        .meta({
          description:
            "The 6-digit access code, or null when the link asks for none. Shown once; send it apart from the link.",
          example: "042424",
        }),
    ),
    classification: Classification,
    expires_at: orNull(fields.instant("When the link stops opening.")),
  })
  .meta({
    id: "ShareLinkToken",
    description: "A new share link with its token and access code, shown once.",
  });

export const shareLinkResources: readonly ResourceSpec[] = [
  resource("Platform", "/share-links", ShareLink, {
    verbs: ["list", "get"],
    actions: [
      collectionAction("create", {
        segment: "",
        summary: "Create a share link",
        description:
          "Makes a link to the current clean version of a file the caller can read, through app.create_share_link. The database applies Section 8.6: Public files may omit `expires_at`; Internal files need one within 90 days; Confidential files need `data.export.confidential`, `expires_at` within 30 days and `recipient_email`, and always get an access code; Restricted files are refused (422 `share_link_restricted`). A Confidential PDF, or an image other than PNG or JPEG, cannot carry the viewer watermark and is refused (422 `share_link_watermark_unsupported`). Answers 201 with the token and access code, shown once.",
        body: ShareLink.create as z.ZodType,
        response: ShareLinkToken,
        rpc: "create_share_link",
        status: 201,
      }),
      itemAction("revoke", {
        summary: "Revoke a share link",
        description:
          "Revokes the link through app.revoke_share_link so it never opens again. The person who made it may revoke it, and so may anyone holding `data.export.confidential` in the org. Revoking a revoked link answers it unchanged.",
        response: ShareLink.read,
        rpc: "revoke_share_link",
      }),
    ],
  }),
];

export const shareLinkCapabilities: Readonly<Record<string, CapabilityRule>> = {
  shareLinks: {
    read: "data.export.run",
    write: "data.export.run",
    actions: { create: "data.export.run", revoke: "data.export.run" },
  },
};
