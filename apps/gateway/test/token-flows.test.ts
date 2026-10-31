import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import en from "../../../packages/i18n/messages/en-US/gateway.json";
import es from "../../../packages/i18n/messages/es-US/gateway.json";
import { KNOWN_REFUSALS, refusalOutcome } from "../lib/action-result";
import { withAdvanceLink } from "../lib/token-form";

/**
 * The advance link's typed sections (R10, migrations 2730 and 2731): the token adapter puts the
 * token and access code in the form body and nowhere else, the page and its actions never put the
 * code in a URL, and every refusal the link can meet has its own copy in both locales, under
 * gateway.tokens.refusals and under gateway.outcomes.refusals, which the typed forms read.
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const flow = read("../components/tokens/token-flows.tsx");
const actions = read("../lib/actions/tokens.ts");

/** Refusals of the R10 RPCs and the R9 rules a token answer reaches through record_advance_answer. */
const TOKEN_REFUSALS = [
  "advance_token_invalid",
  "advance_token_locked",
  "advance_token_expired",
  "advance_access_code",
  "advance_section_open",
  "advance_answer_pending",
  "advance_upload_type",
  "advance_upload_size",
  "advance_upload_limit",
  "advance_upload_rate",
  "advance_upload_ticket",
  "advance_guest_rate",
  "advance_roster_rate",
  "guest_list_closed",
  "guest_name_length",
  "guest_plus_ones",
  "guest_note_length",
  "advance_section_derived",
  "advance_recipient_engagement",
  "advance_section_role",
  "advance_line_limit",
  "advance_line_kind",
  "advance_line_person",
  "advance_line_window",
  "advance_line_roster_entry",
  "advance_file_document",
  "party_upload_missing",
  "party_upload_checksum",
  "guest_list_cap",
  "offering_not_offered",
  "credential_names_closed",
  "roster_closed",
  "roster_role_type",
  "roster_locked",
  "roster_empty_submit",
  "roster_person_duplicate",
  "invitation_email",
  "roster_arrival_window",
  "time_zone_unknown",
];

describe("token adapter", () => {
  it("adds the token and access code to the form body and reports a sent answer", async () => {
    const seen: [string | null, string | null][] = [];
    const action = vi.fn(async (_: object, form: FormData) => {
      seen.push([form.get("token") as string | null, form.get("accessCode") as string | null]);
      return { done: true };
    });
    const onDone = vi.fn();
    const wrapped = withAdvanceLink({ token: "xadv_abc", accessCode: "424242" }, action, onDone);
    const form = new FormData();
    form.set("sectionId", "s1");
    expect(await wrapped({}, form)).toEqual({ done: true });
    expect(seen).toEqual([["xadv_abc", "424242"]]);
    expect(form.get("sectionId")).toBe("s1");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("keeps a refusal and does not report it as sent", async () => {
    const onDone = vi.fn();
    const wrapped = withAdvanceLink(
      { token: "xadv_abc", accessCode: "424242" },
      async () => ({ outcome: refusalOutcome("advance_upload_type") }),
      onDone,
    );
    expect(await wrapped({}, new FormData())).toEqual({ outcome: "refusals.advance_upload_type" });
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("the access code stays out of URLs", () => {
  it("is never part of a link, a navigation or a query string", () => {
    for (const source of [flow, actions]) {
      expect(source).not.toMatch(/searchParams|URLSearchParams|router\.(push|replace)|location\./);
      expect(source).not.toMatch(/[?&](code|accessCode|access_code)=/);
      expect(source).not.toMatch(/href=\{[^}]*(code|accessCode)/);
    }
  });

  it("travels in the body of every typed form through the adapter", () => {
    for (const action of [
      "answerAdvanceTypedTokenAction",
      "uploadAdvanceTokenFileAction",
      "requestTokenGuestAction",
      "inviteTokenRosterAction",
      "submitTokenRosterAction",
    ]) {
      expect(flow, action).toMatch(new RegExp(`withAdvanceLink\\(\\s*link,\\s*${action}`));
      expect(actions, action).toMatch(new RegExp(`export async function ${action}\\(`));
    }
  });

  it("uploads on the server with the anonymous client", () => {
    const upload = actions.slice(
      actions.indexOf("export async function uploadAdvanceTokenFileAction"),
    );
    expect(upload.slice(0, upload.indexOf("\n}\n"))).toMatch(
      /createAnonSupabase\(\)[\s\S]*beginAdvanceUpload[\s\S]*storeAdvanceUpload[\s\S]*finishAdvanceUpload[\s\S]*submitAdvanceTyped/,
    );
  });
});

describe("token refusal copy", () => {
  type Catalog = {
    tokens: { refusals: Record<string, string> };
    outcomes: { refusals: Record<string, string> };
  };
  it.each([
    ["en-US", en as unknown as Catalog],
    ["es-US", es as unknown as Catalog],
  ])("names every refusal the link meets in %s", (_, catalog) => {
    for (const rule of TOKEN_REFUSALS) {
      expect(catalog.tokens.refusals[rule], rule).toBeTruthy();
      expect(catalog.outcomes.refusals[rule], rule).toBeTruthy();
      expect(KNOWN_REFUSALS as readonly string[], rule).toContain(rule);
    }
  });
});
