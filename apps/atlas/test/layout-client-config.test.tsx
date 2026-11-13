// @vitest-environment jsdom
/**
 * What the root layout hands the browser (crawl 4.9):
 *   * the response's CSP nonce, for the stylesheet a dialog injects to lock the page's scroll (react-remove-scroll
 *     reads it through get-nonce); without it production's style-src refuses the sheet and the page keeps scrolling;
 *   * the request's time and zone on the next-intl client provider, so a relative time a client component formats
 *     (an invite's expiry on Settings, Members) logs no ENVIRONMENT_FALLBACK error.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { getNonce } from "get-nonce";
import { NextIntlClientProvider, useFormatter } from "next-intl";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-11-10T15:00:00Z");
vi.mock("next-intl/server", () => ({
  getNow: async () => NOW,
  getTimeZone: async () => "America/New_York",
}));

const { StyleNonce } = await import("@/components/shell/style-nonce");
const { clientTime } = await import("@/i18n/client-time");

afterEach(cleanup);

function Expiry() {
  const format = useFormatter();
  return <p>{format.relativeTime(new Date("2026-11-17T15:00:00Z"))}</p>;
}

describe("the root layout's client configuration", () => {
  it("hands the CSP nonce to the dialogs' scroll-lock stylesheet", () => {
    render(<StyleNonce nonce="bm9uY2Utb25l" />);
    expect(getNonce()).toBe("bm9uY2Utb25l");
  });

  it("formats a relative time against the request's time with no fallback error", async () => {
    const onError = vi.fn();
    render(
      <NextIntlClientProvider
        locale="en-US"
        messages={{}}
        onError={onError}
        {...await clientTime()}
      >
        <Expiry />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText("in 1 week")).toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  });

  it("without them, next-intl reports the fallback the crawl saw", () => {
    const onError = vi.fn();
    render(
      <NextIntlClientProvider locale="en-US" messages={{}} onError={onError}>
        <Expiry />
      </NextIntlClientProvider>,
    );
    expect(onError.mock.calls.some(([e]) => String(e).includes("ENVIRONMENT_FALLBACK"))).toBe(true);
  });

  it("the layout passes both", () => {
    const layout = readFileSync(join(process.cwd(), "app/layout.tsx"), "utf8");
    expect(layout).toContain("<StyleNonce nonce={nonce} />");
    expect(layout).toContain('requestHeaders.get("x-nonce")');
    expect(layout).toMatch(/now=\{time\.now\}\s+timeZone=\{time\.timeZone\}/);
  });
});
