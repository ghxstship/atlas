/**
 * Knowledge operations beyond the frozen v1 catalog (additive only, Section 10.1), and the
 * corrections of frozen Knowledge resources to the A03 schema (ADR 0023, migration 0353).
 */
import { fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { archivedListQuery } from "./parts/archived-filter.ts";
import { all, editShape, orNull, putActions } from "../correct.ts";
import { itemAction } from "../define.ts";
import { documentNotesAction, fieldHistoryAction } from "./parts/bulk-edit-and-history.ts";

const SINCE = "1.0.0-draft.2";

export const additions = defineAdditions("Knowledge", {
  listQuery: { documents: archivedListQuery },
  actions: {
    sops: [fieldHistoryAction("SOP")],
    documents: [fieldHistoryAction("document"), documentNotesAction],
  },
  corrections: [
    {
      id: "sop-code-version",
      since: SINCE,
      resources: ["sops"],
      change:
        "Adds the required, fixed `code` (SOP-NNN), the server-set `version` and `published_at`; `body` is text; removes `urid`, `sop_state` and `requires_acknowledgment`. Adds `sops.publish`.",
      reason:
        "app.sops (0353) is coded SOP-NNN, stores the procedure as text, and is draft until published: publishing (knowledge.sop.publish) stamps `published_at` and raises `version`, which asks everyone to acknowledge again. Every published SOP is acknowledged; there is no flag or state column.",
      apply: all(
        editShape({
          remove: ["urid", "sop_state", "requires_acknowledgment"],
          immutable: ["code"],
          add: {
            code: {
              schema: fields.code("SOP code, SOP- and three to five digits.", "SOP-001"),
              create: "required",
            },
            body: {
              schema: fields.longText(
                "Procedure text.",
                "Confirm the dock slot, then stage by department.",
              ),
              create: "required",
            },
            version: { schema: fields.int("Version number, raised on each publish.", 1, 1) },
            published_at: {
              schema: orNull(
                fields.instant("When the current version was published; null while draft."),
              ),
            },
          },
        }),
        putActions(
          [
            itemAction("publish", {
              summary: "Publish an SOP",
              description:
                "Publishes the SOP: the database stamps `published_at` and raises `version` when it was published before, so everyone is asked to acknowledge the new version. Needs knowledge.sop.publish.",
            }),
          ],
          { publish: "knowledge.sop.publish" },
        ),
      ),
    },
    {
      id: "sop-acknowledgment-version",
      since: SINCE,
      resources: ["sopAcknowledgments"],
      change: "`person_id` is the caller, set from the session; adds the server-set `sop_version`.",
      reason:
        "app.sop_acknowledgments (0353) accepts an acknowledgment only from the person themselves for a published SOP and stamps the current version and time.",
      apply: editShape({
        serverSet: ["person_id"],
        add: { sop_version: { schema: fields.int("Version acknowledged.", 2, 1) } },
      }),
    },
    {
      id: "document-columns",
      since: SINCE,
      resources: ["documents"],
      change:
        "Removes `record_id`, `classification` and `current_version_id` (read the newest document version).",
      reason:
        "app.documents (0353) holds the title and optional project; content lives in append-only app.document_versions, numbered by the database.",
      apply: editShape({ remove: ["record_id", "classification", "current_version_id"] }),
    },
    {
      id: "document-version-location",
      since: SINCE,
      resources: ["documentVersions"],
      change:
        "A version records the required `storage_uri` and `checksum_sha256`; removes `file_name`, `mime_type`, `byte_size` and `sha256`.",
      reason:
        "app.document_versions (0353) stores where the file lives and its SHA-256 (lowercase hex, NOT NULL) and nothing else about the file.",
      apply: editShape({
        remove: ["file_name", "mime_type", "byte_size", "sha256"],
        add: {
          storage_uri: {
            schema: fields.text(
              "Where the file is stored.",
              "https://files.example.com/site-plan-v3.pdf",
              2000,
            ),
            create: "required",
          },
          checksum_sha256: {
            schema: fields.code(
              "SHA-256 of the file, lowercase hex.",
              "9f2c4e1a7b3d5f6e8a0c2e4f6a8b0d2c4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b",
            ),
            create: "required",
          },
        },
      }),
    },
    {
      id: "verbiage-definition",
      since: SINCE,
      resources: ["verbiageTerms"],
      change: "`usage` becomes the required `definition`, a sentence ending in a period.",
      reason:
        "app.verbiage_terms (0353) names the column `definition` (NOT NULL, period-terminated, no em dash, invariant 24).",
      apply: editShape({
        remove: ["usage"],
        add: {
          definition: {
            schema: fields.longText(
              "Definition, a sentence ending in a period.",
              "The arrival of equipment before a show.",
            ),
            create: "required",
          },
        },
      }),
    },
  ],
});
