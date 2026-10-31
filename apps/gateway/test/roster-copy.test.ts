import { describe, expect, it } from "vitest";
import { rosterCopyGroups } from "../lib/roster-copy";

/** Reusing a roster from a past event (B14, G-252): the preview Gateway shows before Add to roster. */

const row = (
  label: string,
  outcome: "copy" | "invite" | "skip",
  skipReason: string | null = null,
) =>
  ({
    sourceEntryId: label,
    label,
    outcome,
    skipReason,
    arrivalStartsAt: null,
    arrivalEndsAt: null,
  }) as const;

describe("roster reuse preview", () => {
  it("groups who is added, who is invited again and who is skipped", () => {
    const groups = rosterCopyGroups([
      row("Pia Larsen", "copy"),
      row("Kai Morgan", "skip", "not_in_team"),
      row("nell@touring.test", "invite"),
      row("Mo Lindqvist", "skip", "already_on_roster"),
    ] as never);
    expect(groups.added.map((i) => i.label)).toEqual(["Pia Larsen"]);
    expect(groups.invited.map((i) => i.label)).toEqual(["nell@touring.test"]);
    expect(groups.skipped.map((i) => i.skipReason)).toEqual(["not_in_team", "already_on_roster"]);
    expect(groups.empty).toBe(false);
  });

  it("offers nothing to add when everyone is skipped", () => {
    expect(
      rosterCopyGroups([row("Mo Lindqvist", "skip", "already_on_roster")] as never).empty,
    ).toBe(true);
  });
});
