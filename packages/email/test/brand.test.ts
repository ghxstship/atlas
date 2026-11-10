/** An org's brand on its email (A138, Section 12): the logo and accent, and the platform fallback. */
import { describe, expect, it } from "vitest";
import { renderEmail, type Sender } from "../src/index.ts";
import { brandAccent, color } from "../src/theme.ts";

const platform: Sender = {
  orgName: "Northwind Live",
  postalAddress: "100 Harbor Way, Miami, FL 33132",
  preferencesUrl: "https://atlas.xos.test/northwind-live/me/notifications",
  unsubscribeUrl: "https://atlas.xos.test/u/unsubscribe/abc",
};

const LOGO = "https://db.xos.test/storage/v1/object/public/org-brand/org-a/logo-light.png";
// Passes: white on #0B5FFF is 5.0:1 and the fill against the light grounds over 3:1.
const ACCENT = "#0B5FFF";
// Fails: white on a pale yellow is under 4.5:1.
const PALE = "#F5E663";

const branded: Sender = {
  ...platform,
  orgName: "Northwind",
  brand: { logoUrl: LOGO, accentHex: ACCENT },
};

const notification = {
  kind: "approval.requested",
  args: { actorName: "Bob Okafor", title: "Rigging rental" },
  url: "https://atlas.xos.test/r/1",
} as const;

function render(sender: Sender) {
  return renderEmail("notification", notification, {
    locale: "en-US",
    timeZone: "America/New_York",
    sender,
    recipientName: "Dave Kim",
  });
}

/** The inline style of the call-to-action link, which React Email renders as an anchor. */
function buttonStyle(html: string): string {
  const anchor = /<a[^>]+href="https:\/\/atlas\.xos\.test\/r\/1"[^>]*>/.exec(html)?.[0] ?? "";
  return /style="([^"]*)"/.exec(anchor)?.[1] ?? "";
}

describe("brandAccent", () => {
  it("keeps an accent that passes the email contrast check, uppercased", () => {
    expect(brandAccent("#0b5fff")).toBe(ACCENT);
  });

  it("drops an accent the button label or the grounds fail on, or that is not a hex color", () => {
    expect(brandAccent(PALE)).toBeNull();
    expect(brandAccent("#FFFFFF")).toBeNull();
    expect(brandAccent("blue")).toBeNull();
    expect(brandAccent(undefined)).toBeNull();
    expect(brandAccent(null)).toBeNull();
  });
});

describe("branded email layout", () => {
  it("renders the platform frame without a brand", async () => {
    const { html } = await render(platform);
    expect(html).not.toContain("<img");
    expect(buttonStyle(html)).toContain(`background-color:${color("accent-default")}`);
    expect(html).toMatchSnapshot();
  });

  it("puts the org's logo above the heading, named by the org, and paints the action in its accent", async () => {
    const { html, text } = await render(branded);
    expect(html).toContain(`<img alt="Northwind" src="${LOGO}"`);
    expect(html.indexOf("<img")).toBeLessThan(html.indexOf("<h1"));
    expect(buttonStyle(html)).toContain(`background-color:${ACCENT}`);
    expect(html).toContain("Sent by Northwind, 100 Harbor Way");
    expect(text).toContain("Sent by Northwind");
    expect(html).toMatchSnapshot();
  });

  it("keeps the platform accent when the org's accent fails the check, and still shows the logo", async () => {
    const { html } = await render({ ...branded, brand: { logoUrl: LOGO, accentHex: PALE } });
    expect(html).toContain(LOGO);
    expect(buttonStyle(html)).toContain(`background-color:${color("accent-default")}`);
    expect(html).not.toContain(PALE);
  });

  it("applies an accent without a logo", async () => {
    const { html } = await render({ ...branded, brand: { accentHex: ACCENT } });
    expect(html).not.toContain("<img");
    expect(buttonStyle(html)).toContain(`background-color:${ACCENT}`);
  });
});
