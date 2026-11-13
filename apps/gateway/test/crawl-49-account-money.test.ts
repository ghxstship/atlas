import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canEditCompanyProfile, canRemoveMember } from "../lib/account-team";
import { KNOWN_REFUSALS } from "../lib/action-result";
import {
  certificateStatus,
  certificateTag,
  engagementInvoicesEmptyKey,
  moneyInvoicesEmptyKey,
  partyInvoiceStatus,
  partyInvoiceStatusKey,
  partyPaymentStatus,
  partyPaymentStatusKey,
  submitsInvoices,
} from "../lib/invoice-status";
import en from "../../../packages/i18n/messages/en-US/gateway.json";
import es from "../../../packages/i18n/messages/es-US/gateway.json";

/**
 * Crawl 4.9 findings for company accounts and money in Gateway (RRR-243, release 4.11): who removes an Owner,
 * who submits invoices, the payout step's way on, party-facing invoice and payment status, read-only company
 * profiles, certificates dated against today, phone cards on Money, Invoices, and the unpaid empty states.
 */

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const lookup = (catalog: unknown, key: string): unknown =>
  key
    .replace(/^gateway\./, "")
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      catalog,
    );

const both = (key: string) => {
  expect(lookup(en, key), `en-US ${key}`).toBeTypeOf("string");
  expect(lookup(es, key), `es-US ${key}`).toBeTypeOf("string");
};

describe("only an Account Owner removes an Account Owner", () => {
  const owner = { personId: "p-owner", roles: ["Account Owner"] };
  const member = { personId: "p-member", roles: ["Account Member"] };

  it("hides Remove on an Owner's row from an Admin", () => {
    expect(
      canRemoveMember({ actingRoles: ["Account Admin"], personId: "p-admin", member: owner }),
    ).toBe(false);
    expect(
      canRemoveMember({ actingRoles: ["Account Admin"], personId: "p-admin", member: member }),
    ).toBe(true);
  });

  it("lets an Owner remove another Owner, and nobody remove themselves from the list", () => {
    expect(
      canRemoveMember({ actingRoles: ["Account Owner"], personId: "p-other", member: owner }),
    ).toBe(true);
    expect(
      canRemoveMember({ actingRoles: ["Account Owner"], personId: "p-owner", member: owner }),
    ).toBe(false);
    expect(
      canRemoveMember({ actingRoles: ["Account Finance"], personId: "p-fin", member: member }),
    ).toBe(false);
  });

  it("is what the team list uses", () => {
    expect(source("components/settings/sections.tsx")).toMatch(/canRemoveMember\(\{/);
    expect(source("components/settings/sections.tsx")).not.toMatch(
      /admin && m\.personId !== ctx\.personId/,
    );
  });
});

describe("a client or sponsor submits no invoice", () => {
  it("leaves the paid role types, and only them, with the form", () => {
    expect(submitsInvoices("Sponsor")).toBe(false);
    expect(submitsInvoices("Client")).toBe(false);
    for (const role of ["Contractor", "Crew", "Staff", "Vendor", "Artist"] as const)
      expect(submitsInvoices(role), role).toBe(true);
  });

  it("gates the Invoices tab's form on it, with no hand-kept list", () => {
    const tab = source("components/engagement/tabs-common.tsx");
    expect(tab).toMatch(/submitsInvoices\(e\.roleType\)/);
    expect(tab).not.toMatch(/"Artist", "Sponsor"\]\.includes/);
  });

  it("has copy for the database refusal in both locales", () => {
    expect(KNOWN_REFUSALS as readonly string[]).toContain("invoice_unpaid_role");
    both("outcomes.refusals.invoice_unpaid_role");
  });

  it("tells a client or sponsor where invoices come from instead of to submit one", () => {
    expect(engagementInvoicesEmptyKey("Sponsor")).toBe("gateway.engagement.invoices.emptyUnpaid");
    expect(engagementInvoicesEmptyKey("Client")).toBe("gateway.engagement.invoices.emptyUnpaid");
    expect(engagementInvoicesEmptyKey("Vendor")).toBe("gateway.engagement.invoices.empty");
    expect(moneyInvoicesEmptyKey(false)).toBe("gateway.money.invoices.emptyUnpaid");
    expect(moneyInvoicesEmptyKey(true)).toBe("gateway.money.invoices.empty");
    for (const key of [
      "gateway.engagement.invoices.emptyUnpaid",
      "gateway.money.invoices.emptyUnpaid",
    ]) {
      both(key);
      expect(lookup(en, key)).not.toMatch(/submit/i);
    }
    expect(source("app/(shell)/money/invoices/page.tsx")).toMatch(/moneyInvoicesEmptyKey\(/);
  });
});

describe("the payout step and page have a way on", () => {
  it("never send the person back to the page they are on", () => {
    for (const catalog of [en, es]) {
      const text = [
        lookup(catalog, "money.tax.noPayouts"),
        lookup(catalog, "engagement.onboarding.payoutHint"),
      ].join(" ");
      expect(text).not.toMatch(/Settings, Payout and tax|Configuración, Pagos e impuestos/);
    }
  });

  it("offers Messages to ask the organization", () => {
    expect(source("components/settings/sections.tsx")).toMatch(/<ButtonLink href="\/messages"/);
    expect(source("components/engagement/tabs-common.tsx")).toMatch(
      /i\.kind === "Payout Details" \?[\s\S]{0,600}engagement\.messages/,
    );
  });
});

describe("invoices and payments read in the tracker's words", () => {
  const invoice = {
    invoice_state: "Proposed",
    approved_at: null,
    balance_minor: 500000,
    applied_minor: 0,
    last_paid_on: null,
    scheduled_minor: 0,
  };

  it("reads a submitted invoice Submitted, not Proposed", () => {
    expect(partyInvoiceStatus(invoice)).toBe("submitted");
    expect(lookup(es, "money.invoices.status.submitted")).not.toBe("Borrador");
  });

  it("follows the tracker through Approved, Scheduled and Paid", () => {
    const approved = { ...invoice, invoice_state: "Approved", approved_at: "2026-11-01T10:00:00Z" };
    expect(partyInvoiceStatus(approved)).toBe("approved");
    expect(partyInvoiceStatus({ ...approved, scheduled_minor: 500000 })).toBe("scheduled");
    expect(
      partyInvoiceStatus({
        ...approved,
        balance_minor: 0,
        applied_minor: 500000,
        last_paid_on: "2026-11-05",
      }),
    ).toBe("paid");
  });

  it("keeps Issued, Disputed and Canceled", () => {
    expect(partyInvoiceStatus({ ...invoice, invoice_state: "Issued" })).toBe("issued");
    expect(partyInvoiceStatus({ ...invoice, invoice_state: "Disputed" })).toBe("disputed");
    expect(partyInvoiceStatus({ ...invoice, invoice_state: "Canceled" })).toBe("canceled");
  });

  it("reads an approved payment Paid", () => {
    expect(partyPaymentStatus("Approved")).toBe("paid");
    expect(partyPaymentStatus("Canceled")).toBe("canceled");
  });

  it("has every status in both locales, and the pages use them", () => {
    for (const s of [
      "submitted",
      "issued",
      "approved",
      "scheduled",
      "paid",
      "disputed",
      "canceled",
    ] as const)
      both(partyInvoiceStatusKey(s));
    for (const s of ["scheduled", "paid", "canceled"] as const) both(partyPaymentStatusKey(s));
    for (const path of [
      "components/engagement/payment-steps.tsx",
      "app/(shell)/money/invoices/page.tsx",
      "app/(shell)/money/payments/page.tsx",
    ]) {
      expect(source(path), path).not.toMatch(/enumLabelKey\("(invoiceState|paymentState)"/);
    }
  });
});

describe("Money, Invoices cards on a phone", () => {
  it("show the number, organization, balance and status", () => {
    expect(source("app/(shell)/money/invoices/page.tsx")).toMatch(
      /cardFields=\{\["number", "org", "balance", "state"\]\}/,
    );
    expect(source("components/page/collections.tsx")).toMatch(/cardFields \? \{ cardFields \}/);
  });
});

describe("the company profile reads for Finance and Members", () => {
  it("is edited by an Owner or Admin only", () => {
    expect(canEditCompanyProfile(["Account Owner"])).toBe(true);
    expect(canEditCompanyProfile(["Account Admin"])).toBe(true);
    expect(canEditCompanyProfile(["Account Finance"])).toBe(false);
    expect(canEditCompanyProfile(["Account Member"])).toBe(false);
  });

  it("creates the profile only for an editor, and shows it read-only to the rest", () => {
    const sections = source("components/settings/sections.tsx");
    expect(sections).toMatch(/getOrganizationProfile\(ctx\.db, ctx\.acting\.id, editor\)/);
    expect(sections).not.toMatch(/getOrganizationProfile\(ctx\.db, ctx\.acting\.id, true\)/);
    expect(sections).toMatch(/<CompanyProfileReadOnly/);
    both("settings.company.profileReadOnly");
    for (const catalog of [en, es])
      expect(lookup(catalog, "settings.company.profileUnavailable")).not.toMatch(/Atlas/);
  });
});

describe("insurance certificates are dated against today", () => {
  const today = "2026-11-10";

  it("reads a certificate not yet in force as starting, never Expired", () => {
    expect(certificateStatus({ valid_from: "2027-01-01", valid_to: "2027-12-31" }, today)).toBe(
      "notYetInForce",
    );
  });

  it("warns in the last 30 days, and is current before and expired after", () => {
    expect(certificateStatus({ valid_from: "2026-01-01", valid_to: "2026-11-30" }, today)).toBe(
      "expiringSoon",
    );
    expect(certificateStatus({ valid_from: "2026-01-01", valid_to: "2026-12-10" }, today)).toBe(
      "expiringSoon",
    );
    expect(certificateStatus({ valid_from: "2026-01-01", valid_to: "2026-12-11" }, today)).toBe(
      "current",
    );
    expect(certificateStatus({ valid_from: "2025-01-01", valid_to: "2026-11-09" }, today)).toBe(
      "expired",
    );
    expect(certificateStatus({ valid_from: "2025-01-01", valid_to: "2026-11-10" }, today)).toBe(
      "expiringSoon",
    );
  });

  it("dates the tag in both locales and is what both lists use", () => {
    const t = (key: string, values?: Record<string, string | number>) =>
      `${key}${values ? `:${Object.values(values).join(",")}` : ""}`;
    expect(
      certificateTag({ valid_from: "2027-01-01", valid_to: "2027-12-31" }, today, t, (d) => d),
    ).toEqual({ label: "gateway.engagement.compliance.startsOn:2027-01-01", tone: "warning" });
    both("engagement.compliance.startsOn");
    both("engagement.compliance.expiresOn");
    for (const path of [
      "components/engagement/tabs-vendor.tsx",
      "components/settings/sections.tsx",
    ]) {
      expect(source(path), path).toMatch(/certificateTag\(c, /);
      expect(source(path), path).not.toMatch(/c\.is_current\s*\?/);
    }
  });
});
