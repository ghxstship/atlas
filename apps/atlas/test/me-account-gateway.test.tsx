import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import enShell from "../../../packages/i18n/messages/en-US/shell.json";
import esShell from "../../../packages/i18n/messages/es-US/shell.json";
import enSettings from "../../../packages/i18n/messages/en-US/settings.json";

/**
 * Me, Account (crawl 4.9) promised email, phone, linked sign-ins and data export, and had none of them nor a way to
 * delete the account. The account lives in Gateway: the page now says so and links to Gateway's Settings, Account.
 */
vi.mock("@/lib/shell/translate", () => ({
  getTranslate: async () => (key: string) => {
    const value = key
      .split(".")
      .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], {
        settings: enSettings,
      });
    return typeof value === "string" ? value : key;
  },
}));

const { contributions } = await import("@/components/settings/contributions/a31");

describe("Me, Account", () => {
  it("links to the account in Gateway", async () => {
    vi.stubEnv("GATEWAY_SITE_URL", "https://gateway.example");
    const panel = contributions.find((c) => c.node === "me.account" && c.order === 0);
    expect(panel).toBeDefined();
    const element = await (panel?.Panel as unknown as (p: unknown) => Promise<React.ReactElement>)({
      ctx: {},
      params: {},
    });
    const html = renderToStaticMarkup(element);
    expect(html).toContain('href="https://gateway.example/settings/account"');
    expect(html).toContain(enSettings.account.gatewayLink);
    vi.unstubAllEnvs();
  });

  it("promises no phone or data export it does not have", () => {
    for (const lead of [enShell.pages.me.account.empty, esShell.pages.me.account.empty]) {
      expect(lead).not.toMatch(/phone|teléfono|export/i);
      expect(lead).toContain("Gateway");
    }
  });
});
