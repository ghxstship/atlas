import { createFormatter } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Finding A53-001: the pseudo-locales (en-XA, ar-XB) format dates and numbers as en-US. next-intl's request locale is
 * what every formatter reads (getFormatter, useFormatter, and getLocale or useLocale handed to Intl and XOSProvider),
 * so i18n/request.ts returns the formatting locale there and keeps the pseudo messages; the layout takes the
 * negotiated locale for the document language and direction.
 */
const jar = vi.hoisted(() => ({ locale: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "xos-locale" && jar.locale !== undefined ? { value: jar.locale } : undefined,
  }),
  headers: async () => new Headers({ "accept-language": "en-US" }),
}));
// Outside a server component next-intl refuses getRequestConfig; on the server it returns the function it is given.
vi.mock("next-intl/server", () => ({ getRequestConfig: <T>(create: T) => create }));

const { default: requestConfig, negotiatedLocale } = await import("../i18n/request");

type Config = { locale: string; messages: { shell: { gateway: { name: string } } } };
const configFor = async (locale: string) => {
  jar.locale = locale;
  return (await requestConfig({ requestLocale: Promise.resolve(undefined) })) as unknown as Config;
};

const AT = new Date("2026-10-08T14:30:00Z");
type FormatLocale = Parameters<typeof createFormatter>[0]["locale"];
const formatted = (locale: string) => {
  const format = createFormatter({ locale: locale as FormatLocale, timeZone: "UTC" });
  return [format.dateTime(AT, { dateStyle: "medium" }), format.number(1234.5)];
};

describe("formatting locale (A53-001)", () => {
  beforeEach(() => {
    jar.locale = undefined;
  });

  it("formats a pseudo-locale as en-US and keeps its pseudo messages", async () => {
    for (const pseudo of ["en-XA", "ar-XB"]) {
      const config = await configFor(pseudo);
      expect(config.locale).toBe("en-US");
      expect(config.messages.shell.gateway.name).not.toBe(
        (await configFor("en-US")).messages.shell.gateway.name,
      );
      expect(formatted(config.locale)).toEqual(["Oct 8, 2026", "1,234.5"]);
    }
  });

  it("formats a shipped locale in itself", async () => {
    const config = await configFor("es-US");
    expect(config.locale).toBe("es-US");
    expect(formatted(config.locale)[1]).toBe("1,234.5");
  });

  it("keeps the pseudo-locale for the document language and direction", async () => {
    jar.locale = "ar-XB";
    expect(await negotiatedLocale()).toBe("ar-XB");
  });
});
