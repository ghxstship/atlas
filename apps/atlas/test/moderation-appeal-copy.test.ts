import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import enEmail from "../../../packages/i18n/messages/en-US/email.json";
import esEmail from "../../../packages/i18n/messages/es-US/email.json";
import enNav from "../../../packages/i18n/messages/en-US/nav.json";
import esNav from "../../../packages/i18n/messages/es-US/nav.json";
import enPlatform from "../../../packages/i18n/messages/en-US/platform.json";
import esPlatform from "../../../packages/i18n/messages/es-US/platform.json";

/**
 * The listing removal notice told the org to appeal "from Opportunities, Marketplace settings", a page with no decision
 * and no Appeal button (crawl 4.9). The appeal lives in the Moderation decisions panel, which A90 contributes to
 * Settings, Gateway and Marketplace; the notice names that page and panel.
 */
const a90 = readFileSync(
  new URL("../components/settings/contributions/a90.tsx", import.meta.url),
  "utf8",
);

describe("the listing moderation notice", () => {
  it("names the page and panel that hold the Appeal button", () => {
    expect(a90).toMatch(
      /node: "settings\.gateway-and-marketplace", order: \d+, Panel: ModerationDecisionsPanel/,
    );
    for (const [email, nav, platform] of [
      [enEmail, enNav, enPlatform],
      [esEmail, esNav, esPlatform],
    ] as const) {
      const body = email.kinds.listing.moderated.body;
      expect(body).toContain(nav.settings.org.gatewayAndMarketplace);
      expect(body).toContain(platform.moderation.title);
      expect(body).not.toMatch(/Marketplace settings|Configuración del mercado/);
    }
  });
});
