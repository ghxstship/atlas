import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KNOWN_REFUSALS } from "../lib/action-result";

/**
 * The Advance tab's typed answer forms and the sponsor's supply forms (R9, Section 11.10): each
 * shows at most seven fields before More fields as it first renders (one line or window), and the
 * screen keeps one primary action: every answer form is a row form whose submit is secondary, and
 * only the sponsor's Supply an asset form, which stands alone, is primary. Read from the source, so
 * the count follows the forms as they are written.
 */

const source = readFileSync(
  fileURLToPath(new URL("../components/engagement/advance-forms.tsx", import.meta.url)),
  "utf8",
);

/** The body of each exported form, by name. */
function forms(): Map<string, string> {
  const out = new Map<string, string>();
  const parts = source.split(/^export function /m).slice(1);
  for (const part of parts) {
    const name = part.slice(0, part.indexOf("("));
    out.set(name, part);
  }
  return out;
}

const FIELD = /<(Input|Select|Textarea|FileField)\b/g;

function visibleFields(body: string): number {
  // Fields inside a MoreFields block do not count; the rest show as the form first renders.
  const outside = body.replace(/<MoreFields>[\s\S]*?<\/MoreFields>/g, "");
  return [...outside.matchAll(FIELD)].length;
}

describe("advance forms", () => {
  const all = forms();

  it("covers every typed answer form and the sponsor's forms", () => {
    expect([...all.keys()].sort()).toEqual([
      "AdvanceFileForm",
      "AdvanceLinesForm",
      "GuestListConfirmForm",
      "ResubmitSponsorAssetForm",
      "SupplySponsorAssetForm",
    ]);
  });

  it("shows at most seven fields before More fields", () => {
    for (const [name, body] of all) {
      expect(visibleFields(body), name).toBeLessThanOrEqual(7);
    }
  });

  it("keeps one primary action per screen", () => {
    for (const [name, body] of all) {
      const row = /<FormShell\s+row\b/.test(body);
      expect(row, name).toBe(name !== "SupplySponsorAssetForm");
      expect(body.includes('variant="primary"'), name).toBe(false);
    }
  });

  it("gives every refusal of the typed advance its own copy", () => {
    for (const rule of [
      "advance_answer_pending",
      "advance_section_derived",
      "advance_section_role",
      "advance_recipient_engagement",
      "advance_line_limit",
      "advance_line_roster_entry",
      "advance_file_document",
      "party_upload_missing",
      "party_upload_checksum",
      "offering_not_offered",
      "guest_list_cap",
      "sponsor_asset_files_required",
      "credential_names_closed",
    ]) {
      expect(KNOWN_REFUSALS as readonly string[], rule).toContain(rule);
    }
  });
});
