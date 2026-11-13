// @vitest-environment jsdom
/**
 * 904110601 refuses accepting a roster entry whose person declined (roster_entry_declined). Crew review in Atlas offered
 * Accept on such an entry anyway, and the refusal read as the general "The database refused this change". A declined
 * entry now offers Return alone with a sentence saying why, and the refusal has its own copy in both languages.
 */
import { getMessages } from "@xos/i18n";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import enAdvancing from "../../../packages/i18n/messages/en-US/advancing.json";
import esAdvancing from "../../../packages/i18n/messages/es-US/advancing.json";
import { KNOWN_ERRORS } from "@/components/advancing/errors";

vi.mock("@/components/advancing/roster-actions", () => ({ reviewRosterEntryAction: vi.fn() }));

const { RosterReviewActions } = await import("@/components/advancing/roster-forms");
const messages = getMessages("en-US");
const copy = enAdvancing.crew;

afterEach(cleanup);

const tree = (declined: boolean) =>
  h(NextIntlClientProvider, {
    locale: "en-US",
    messages,
    timeZone: "America/New_York",
    children: h(RosterReviewActions, { org: "acme", id: "e1", name: "Kai", declined }),
  });

describe("reviewing a roster entry whose person declined", () => {
  it("offers Return alone and says why", () => {
    render(tree(true));
    expect(screen.queryByRole("button", { name: copy.accept })).toBeNull();
    expect(screen.getByRole("button", { name: copy.return })).toBeTruthy();
    expect(screen.getByText(/Kai declined their place/)).toBeTruthy();
  });

  it("keeps Accept for an entry its person has not declined", () => {
    render(tree(false));
    expect(screen.getByRole("button", { name: copy.accept })).toBeTruthy();
    expect(screen.queryByText(/declined their place/)).toBeNull();
  });

  it("explains the refusal in en-US and es-US", () => {
    expect(KNOWN_ERRORS.has("roster_entry_declined")).toBe(true);
    expect(enAdvancing.errors.roster_entry_declined).toMatch(/Return the entry/);
    expect(esAdvancing.errors.roster_entry_declined).toMatch(/Devuelve la entrada/);
    expect(esAdvancing.crew.declinedReturn).toMatch(/\{name\}/);
  });
});
