import { RecordingTransport } from "@xos/email";
import { describe, expect, it } from "vitest";
import {
  dispatchGuestEmails,
  guestEmailStore,
  guestFrom,
  guestUnsubscribeUrl,
  type ClaimedGuestEmail,
  type GuestEmailStore,
} from "../src/notifications/guest-emails.ts";
import type { PlatformDb } from "../src/stores.ts";

/** Guest list emails (B8, gap G-71, migration 2975): the guest-email worker, with fakes. Nothing leaves the machine. */
const OPTIONS = {
  unsubscribeUrl: "https://project.supabase.test/functions/v1/email-unsubscribe",
  gatewayUrl: "https://gateway.xos.test",
  fromAddress: "XOS <guests@mail.xos.test>",
  postalAddress: "100 Harbor Way, Miami, FL 33132",
};

const BASE: ClaimedGuestEmail = {
  id: "ge-1",
  orgId: "org-a",
  orgName: "Northwind Live",
  projectName: "Northwind Summer Series",
  guestListEntryId: "g-1",
  kind: "Invitation",
  subject: null,
  body: null,
  locale: "en-US",
  to: "sasha@example.test",
  guestName: "Sasha Bell",
  plusOnes: 1,
  unsubscribeToken: "xgue_abc",
  pass: null,
};

const PASS = {
  projectId: "prj-1",
  projectKey: "NWL",
  timeZone: "America/New_York",
  passCode: "GP-ABCDEFGHIJ",
  passCategoryCode: "VIP",
  passCategoryName: "VIP Guest",
  tableLabel: "Table 4",
  showName: null,
  showDay: "2027-06-04",
  decidedAt: "2027-05-20T18:00:00Z",
};

function store(claims: ClaimedGuestEmail[]) {
  const finished: [string, string | null, string | null][] = [];
  const s: GuestEmailStore = {
    claim: async () => claims,
    finish: async (...args) => {
      finished.push(args);
    },
  };
  return { s, finished };
}

describe("guest emails", () => {
  it("sends from the org's name with the one-click unsubscribe headers and the postal address", async () => {
    const transport = new RecordingTransport();
    const { s, finished } = store([BASE]);
    const rendered: string[] = [];
    const summary = await dispatchGuestEmails(
      s,
      transport,
      async (c) => {
        rendered.push(c.id);
        return new Uint8Array([1]);
      },
      OPTIONS,
    );
    expect(summary).toEqual({ attempted: 1, sent: 1, failed: 0 });
    const sent = transport.sent[0];
    expect(sent?.from).toBe('"Northwind Live" <guests@mail.xos.test>');
    expect(sent?.headers?.["List-Unsubscribe"]).toBe(
      "<https://project.supabase.test/functions/v1/email-unsubscribe?guest=xgue_abc>",
    );
    expect(sent?.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(sent?.text).toContain("100 Harbor Way, Miami, FL 33132");
    expect(sent?.tags).toContainEqual({ name: "org_id", value: "org-a" });
    expect(sent?.attachments).toBeUndefined();
    expect(rendered).toEqual([]);
    expect(finished).toEqual([["ge-1", "recorded-1", null]]);
  });

  it("attaches the A6 pass to a Pass email only", async () => {
    const transport = new RecordingTransport();
    const { s } = store([
      { ...BASE, kind: "Pass", pass: PASS },
      { ...BASE, id: "ge-2", kind: "Message", subject: "Doors at 7", body: "Doors open at 7." },
    ]);
    const passes: string[] = [];
    await dispatchGuestEmails(
      s,
      transport,
      async (_claim, pass) => {
        passes.push(pass.passCode);
        return new Uint8Array([37, 80, 68, 70]);
      },
      OPTIONS,
    );
    expect(passes).toEqual(["GP-ABCDEFGHIJ"]);
    expect(transport.sent[0]?.attachments).toEqual([
      {
        filename: "guest-pass-GP-ABCDEFGHIJ.pdf",
        content: new Uint8Array([37, 80, 68, 70]),
        contentType: "application/pdf",
      },
    ]);
    expect(transport.sent[1]?.attachments).toBeUndefined();
    expect(transport.sent[1]?.subject).toBe("Doors at 7");
  });

  it("never sends a Pass email without its pass", async () => {
    const transport = new RecordingTransport();
    const { s, finished } = store([{ ...BASE, kind: "Pass", pass: null }]);
    const summary = await dispatchGuestEmails(
      s,
      transport,
      async () => new Uint8Array([1]),
      OPTIONS,
    );
    expect(summary).toEqual({ attempted: 1, sent: 0, failed: 1 });
    expect(transport.sent).toEqual([]);
    expect(finished[0]?.[2]).toMatch(/pass code/);
  });

  it("records a failure and goes on", async () => {
    const transport = new RecordingTransport();
    const { s, finished } = store([
      { ...BASE, kind: "Pass", pass: PASS },
      { ...BASE, id: "ge-2" },
    ]);
    const summary = await dispatchGuestEmails(
      s,
      transport,
      async () => {
        throw new Error("The pass could not be rendered.");
      },
      OPTIONS,
    );
    expect(summary).toEqual({ attempted: 2, sent: 1, failed: 1 });
    expect(finished[0]).toEqual(["ge-1", null, "The pass could not be rendered."]);
  });

  it("never names the guest in the From header and keeps the token in the link only", () => {
    expect(guestFrom('Bad "Org"\r\n', "guests@mail.xos.test")).toBe(
      '"Bad Org" <guests@mail.xos.test>',
    );
    expect(guestUnsubscribeUrl(OPTIONS.unsubscribeUrl, "xgue_a b")).toBe(
      "https://project.supabase.test/functions/v1/email-unsubscribe?guest=xgue_a+b",
    );
  });

  it("claims and finishes through the service-role RPCs", async () => {
    const calls: [string, unknown][] = [];
    const db = {
      rpc: async (name: string, args: unknown) => {
        calls.push([name, args]);
        return name === "claim_guest_emails"
          ? [
              {
                guest_email_id: "ge-1",
                org_id: "org-a",
                org_name: "Northwind Live",
                project_name: "Northwind Summer Series",
                guest_list_entry_id: "g-1",
                email_kind: "Pass",
                subject: null,
                body: null,
                locale: "es-US",
                to_email: "sasha@example.test",
                guest_name: "Sasha Bell",
                plus_ones: 2,
                unsubscribe_token: "xgue_abc",
                project_id: "prj-1",
                pass_code: "GP-ABCDEFGHIJ",
                project_key: "NWL",
                time_zone: "America/New_York",
                pass_category_code: "VIP",
                pass_category_name: "VIP Guest",
                table_label: null,
                show_name: null,
                show_day: "2027-06-04",
                decided_at: "2027-05-20T18:00:00Z",
              },
            ]
          : null;
      },
    } as unknown as PlatformDb;
    const s = guestEmailStore(db);
    const claims = await s.claim(50);
    expect(claims[0]).toMatchObject({ id: "ge-1", kind: "Pass", locale: "es-US", plusOnes: 2 });
    expect(claims[0]?.pass).toEqual({
      projectId: "prj-1",
      projectKey: "NWL",
      timeZone: "America/New_York",
      passCode: "GP-ABCDEFGHIJ",
      passCategoryCode: "VIP",
      passCategoryName: "VIP Guest",
      tableLabel: null,
      showName: null,
      showDay: "2027-06-04",
      decidedAt: "2027-05-20T18:00:00Z",
    });
    await s.finish("ge-1", "msg-1", null);
    expect(calls).toEqual([
      ["claim_guest_emails", { p_limit: 50 }],
      ["finish_guest_email", { p_id: "ge-1", p_provider_message_id: "msg-1", p_error: null }],
    ]);
  });
});

describe("the attached guest pass", () => {
  it("renders the claim's pass as one A6 page with the door code, in the email's language", async () => {
    const { guestPassRenderer } = await import("../edge/guest-email.ts");
    const render = guestPassRenderer("https://gateway.xos.test");
    for (const locale of ["en-US", "es-US"] as const) {
      const pdf = Buffer.from(
        await render({ ...BASE, kind: "Pass", locale, pass: PASS }, PASS),
      ).toString("latin1");
      expect(pdf.startsWith("%PDF-")).toBe(true);
      expect(pdf).toContain("/MediaBox [0 0 297.64 419.53]");
      expect((pdf.match(/\/Type \/Page\b(?!s)/g) ?? []).length).toBe(1);
      expect(pdf).toContain(`/Lang (${locale})`);
      if (locale === "en-US") expect(pdf).toContain("Door code for guest pass GP-ABCDEFGHIJ");
    }
  }, 60_000);
});
