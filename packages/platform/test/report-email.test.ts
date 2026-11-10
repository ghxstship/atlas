import { describe, expect, it } from "vitest";
import type { ReportDelivery } from "../../data/src/report-deliveries.ts";
import { packEmailLinks, type MintedPackLink } from "../../data/src/stakeholder-packs.ts";
import { packEmailComposer, reportEmailComposer } from "../edge/report-email.ts";
import type { PlatformDb } from "../src/stores.ts";

/**
 * report-run's emails wear the org's brand (A138, 904090003): the scheduled report and the stakeholder pack render
 * through packages/email with the footer, the postal address and the one-click unsubscribe, and while white label is
 * in force the brand name, From name, reply-to, logo and accent. Fakes only: nothing leaves the machine.
 */
const BRAND = {
  brand_name: "Northwind Presents",
  sender_name: "Northwind Reports Desk",
  reply_to: "reports@northwind.test",
  logo_path: "org-1/logo light.png",
  accent_hex: "#0B5FFF",
  suppress_powered_by: false,
};

function db(brand: Record<string, unknown> | null) {
  const calls: [string, unknown][] = [];
  const fake: PlatformDb = {
    rpc: async (fn, args) => {
      calls.push([fn, args]);
      if (fn === "email_brand_for_org") return brand === null ? [] : [brand];
      if (fn === "unsubscribe_token") return "tok.en.reports.sig";
      if (fn === "recipient_setting") {
        const key = (args as { p_setting_key: string }).p_setting_key;
        return key === "locale.language" ? "es-US" : "America/New_York";
      }
      return null;
    },
    selectOne: async () => ({ full_name: "Demo Producer" }),
  };
  return { fake, calls };
}

const delivery: ReportDelivery = {
  deliveryId: "d-1",
  orgId: "org-1",
  orgSlug: "northwind",
  orgName: "Northwind Live",
  reportName: "Spend by Account",
  exportFormat: "PDF",
  storagePath: "org-1/run-1.pdf",
  rowCount: 2,
  unpricedCount: 1,
  recipientEmail: "producer@example.com",
  recipientName: "Demo Producer",
  status: "Queued",
  scheduledFor: "2026-10-19T13:00:00Z",
  recipientPersonId: "p-1",
  reportDefinitionId: "def-1",
  suppressed: false,
};

const attachment = {
  filename: "spend.pdf",
  contentType: "application/pdf",
  content: new Uint8Array([1]),
};

const OPTIONS = {
  appUrl: "https://atlas.xos.test/",
  postalAddress: "100 Harbor Way, Miami, FL 33132",
  fromAddress: "XOS <notifications@mail.xos.test>",
  functionsUrl: "https://project.supabase.test/functions/v1",
  brandAssetUrl: "https://project.supabase.test/storage/v1/object/public/org-brand",
};

describe("the scheduled report email", () => {
  it("wears the org's white label, in the recipient's language, with the file, footer and one-click unsubscribe", async () => {
    const { fake, calls } = db(BRAND);
    const email = await reportEmailComposer({ db: fake, ...OPTIONS })(delivery, attachment);
    expect(email.to).toBe("producer@example.com");
    expect(email.fromName).toBe("Northwind Reports Desk");
    expect(email.replyTo).toBe("reports@northwind.test");
    expect(email.attachment).toBe(attachment);
    expect(email.subject).toContain("Spend by Account");
    expect(email.html).toContain(
      'src="https://project.supabase.test/storage/v1/object/public/org-brand/org-1/logo%20light.png"',
    );
    expect(email.html).toContain("https://atlas.xos.test/northwind/reports/builder?report=def-1");
    expect(email.text).toContain("Northwind Presents");
    expect(email.text).toContain("100 Harbor Way, Miami, FL 33132");
    expect(email.text).not.toContain("Northwind Live");
    // es-US copy: the recipient's language.
    expect(email.text).toContain("Tiene 2 filas");
    const unsubscribe =
      "https://project.supabase.test/functions/v1/email-unsubscribe?token=tok.en.reports.sig";
    expect(email.headers).toEqual({
      "List-Unsubscribe": `<${unsubscribe}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(email.html).toContain(unsubscribe);
    expect(calls).toContainEqual([
      "unsubscribe_token",
      { p_org_id: "org-1", p_person_id: "p-1", p_category: "reports" },
    ]);
  });

  it("goes out under the org's own name without white label, and links no report the recipient may not open", async () => {
    const { fake } = db(null);
    const email = await reportEmailComposer({ db: fake, ...OPTIONS })(
      { ...delivery, reportDefinitionId: null },
      attachment,
    );
    expect(email.fromName).toBe("Northwind Live");
    expect(email).not.toHaveProperty("replyTo");
    expect(email.html).not.toContain("/reports/builder");
    expect(email.html).not.toContain("org-brand");
    expect(email.text).toContain("XOS");
  });

  it("fails with the reason without the postal address or the app address", async () => {
    const { fake } = db(null);
    await expect(
      reportEmailComposer({ db: fake, ...OPTIONS, postalAddress: undefined })(delivery, attachment),
    ).rejects.toThrow(/XOS_POSTAL_ADDRESS/);
    await expect(
      reportEmailComposer({ db: fake, ...OPTIONS, appUrl: null })(delivery, attachment),
    ).rejects.toThrow(/XOS_APP_URL/);
  });
});

const TOKEN = `xpkl_${"ab".repeat(32)}`;
const UNSUB = `xpku_${"cd".repeat(32)}`;

const minted: MintedPackLink = {
  token: TOKEN,
  unsubscribeToken: UNSUB,
  expiresAt: "2026-07-08T03:59:00Z",
  email: {
    recipientName: "Cleo",
    recipientEmail: "cleo@client.test",
    locale: "en-US",
    orgId: "org-1",
    orgName: "Northwind Live",
    brandName: "Northwind Presents",
    whiteLabel: true,
    brandSenderName: "Northwind Client Desk",
    replyTo: "clients@northwind.test",
    logoPath: "org-1/logo.png",
    accentHex: "#0B5FFF",
    suppressPoweredBy: true,
    packName: "Client pack",
    message: "Welcome <b>",
    itemTitles: ["Plan", "Show clock"],
    senderName: "Carol",
    expiresAt: "2026-07-08T03:59:00Z",
    timeZone: "America/New_York",
  },
};

describe("the stakeholder pack email", () => {
  const links = packEmailLinks(minted, {
    appUrl: "https://atlas.test",
    apiUrl: "https://api.test",
  });
  const compose = packEmailComposer({
    fromAddress: OPTIONS.fromAddress,
    brandAssetUrl: OPTIONS.brandAssetUrl,
  });

  it("carries the link, the stop page, one-click headers and the CAN-SPAM footer, never a file or a code", async () => {
    const email = await compose(minted, links, { postalAddress: "1 Main St, Miami FL" });
    expect(email.text).toContain(`https://atlas.test/share/pack/${TOKEN}`);
    expect(email.text).toContain(`https://atlas.test/share/pack/unsubscribe/${UNSUB}`);
    expect(email.headers).toEqual({
      "List-Unsubscribe": `<https://api.test/functions/v1/email-unsubscribe?token=${UNSUB}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(email.text).toContain("Sent by Northwind Presents, 1 Main St, Miami FL");
    expect(email.text).toContain("Jul 7, 2026");
    expect(email.attachment).toBeUndefined();
    expect(JSON.stringify(email)).not.toMatch(/\b\d{6}\b/);
  });

  it("wears the white label while it is in force, and escapes what the team typed", async () => {
    const email = await compose(minted, links, { postalAddress: "1 Main St, Miami FL" });
    expect(email.fromName).toBe("Northwind Client Desk");
    expect(email.replyTo).toBe("clients@northwind.test");
    expect(email.subject).toBe("Carol shared Client pack with you");
    expect(email.html).toContain("org-brand/org-1/logo.png");
    expect(email.text).not.toContain("Delivered by XOS");
    expect(email.html).toContain("Welcome &lt;b&gt;");
  });

  it("goes out under the org's own name without white label", async () => {
    const plain = {
      ...minted,
      email: { ...minted.email, whiteLabel: false, brandName: "Northwind Live", senderName: null },
    };
    const email = await compose(plain, links, { postalAddress: "1 Main St, Miami FL" });
    expect(email.fromName).toBe("Northwind Live");
    expect(email).not.toHaveProperty("replyTo");
    expect(email.subject).toBe("Northwind Live shared Client pack with you");
    expect(email.html).not.toContain("org-brand");
    expect(email.text).toContain("Delivered by XOS");
  });
});
