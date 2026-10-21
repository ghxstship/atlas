import { describe, expect, it, vi } from "vitest";
import { getMessages, locales } from "@xos/i18n";

/** Resend, replaced so the test sees when and how the lazy client builds it. */
const resend = vi.hoisted(() => ({
  keys: [] as string[],
  sends: [] as unknown[],
}));
vi.mock("resend", () => ({
  Resend: class {
    readonly emails = {
      send: async (payload: unknown) => {
        resend.sends.push(payload);
        return { data: { id: "re_lazy_1" }, error: null, headers: null };
      },
    };
    constructor(key: string) {
      resend.keys.push(key);
    }
  },
}));

const { TEMPLATE_CODES, emailCatalog, lazyResendClient, templates } =
  await import("../src/index.ts");

describe("loading on demand (A85, Edge Function cold starts)", () => {
  it("lists exactly the templates, so isTemplateCode needs no React", () => {
    expect([...TEMPLATE_CODES].sort()).toEqual(Object.keys(templates).sort());
  });

  it("builds the Resend client on the first send only, once, with the key", async () => {
    const key = ["re", "lazy", "placeholder"].join("_");
    const client = lazyResendClient(key);
    expect(resend.keys).toEqual([]);
    const payload = { from: "XOS <n@xos.test>", to: ["a@xos.test"], subject: "S", text: "T" };
    await expect(client.emails.send(payload)).resolves.toMatchObject({ data: { id: "re_lazy_1" } });
    await client.emails.send(payload);
    expect(resend.keys).toEqual([key]);
    expect(resend.sends).toEqual([payload, payload]);
  });

  it.each(locales)(
    "reads the %s email namespace from its own file, as the catalog has it",
    (locale) => {
      expect(emailCatalog(locale)).toEqual(getMessages(locale).email);
    },
  );
});
