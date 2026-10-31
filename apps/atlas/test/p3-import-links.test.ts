import { describe, expect, it } from "vitest";
import { importLinkHref, type ImportDestination } from "@/lib/imports/import-link";

/**
 * P3 (RRR-217) acceptance 16 and correction C14: the Import cues and Import guests links show only to someone who
 * holds the target's write capability on the destination and may open the import page. The four roles that see
 * the import page get the link with the capability; collaborator, field and viewer never do, even holding it.
 */

const RUN = "0192a000-0000-7000-8000-000000000001";
const PROJECT = "0192a000-0000-7000-8000-000000000002";
const CUES: ImportDestination = { target: "cues", runOfShowId: RUN };
const GUESTS: ImportDestination = { target: "guest_list_entries", projectId: PROJECT };
const SEES_IMPORT = ["owner", "admin", "manager", "member"] as const;
const NO_IMPORT = ["collaborator", "field", "viewer"] as const;

describe("import links", () => {
  it.each(SEES_IMPORT)(
    "a %s holding the capability gets both links, on their destination",
    (role) => {
      const nav = { role, conditions: ["desktop" as const] };
      expect(importLinkHref("demo", nav, true, CUES)).toBe(
        `/demo/import?target=cues&runOfShow=${RUN}`,
      );
      expect(importLinkHref("demo", nav, true, GUESTS)).toBe(
        `/demo/import?target=guest_list_entries&project=${PROJECT}`,
      );
    },
  );

  it.each(SEES_IMPORT)("a %s without the capability gets neither link", (role) => {
    const nav = { role, conditions: ["desktop" as const] };
    expect(importLinkHref("demo", nav, false, CUES)).toBeNull();
    expect(importLinkHref("demo", nav, false, GUESTS)).toBeNull();
  });

  it.each(NO_IMPORT)("a %s gets neither link, even holding the project capability", (role) => {
    const nav = { role, conditions: ["desktop" as const] };
    expect(importLinkHref("demo", nav, true, CUES)).toBeNull();
    expect(importLinkHref("demo", nav, true, GUESTS)).toBeNull();
  });

  it("no session gets no link", () => {
    expect(importLinkHref("demo", { role: null }, true, CUES)).toBeNull();
  });
});
