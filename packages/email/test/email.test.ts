import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { locales } from "@xos/i18n";
import {
  EmailSendError,
  GuardedTransport,
  RecipientRefusedError,
  RecordingTransport,
  ResendTransport,
  createTransport,
  formatMessage,
  hasMessage,
  isTemplateCode,
  readEmailEnv,
  recipientAllowed,
  renderEmail,
  sendEmail,
  templates,
  type ResendClient,
  type Sender,
  type TemplateCode,
  type TemplateProps,
} from "../src/index.ts";
import { color, layout, radius, space, stroke, text } from "../src/theme.ts";

const sender: Sender = {
  orgName: "Northwind Live",
  postalAddress: "100 Harbor Way, Miami, FL 33132",
  preferencesUrl: "https://atlas.xos.test/me/notifications",
  unsubscribeUrl: "https://atlas.xos.test/u/unsubscribe/abc",
};

const when = new Date("2026-11-03T15:30:00Z");

const samples: { readonly [C in TemplateCode]: TemplateProps[C] } = {
  notification: {
    kind: "approval.requested",
    args: { actorName: "Bob Okafor", title: "Rigging rental" },
    url: "https://atlas.xos.test/r/1",
  },
  digest: {
    frequency: "weekly",
    items: [
      {
        kind: "comment.created",
        args: { actorName: "Carol Nguyen", title: "Dock schedule" },
        url: "https://atlas.xos.test/r/2",
      },
      {
        kind: "assignment.created",
        args: { actorName: "Bob Okafor", title: "Stage deck" },
        url: "https://atlas.xos.test/r/3",
      },
    ],
  },
  invite: {
    inviterName: "Alice Moreno",
    roleName: "Manager",
    acceptUrl: "https://atlas.xos.test/invite/t",
    expiresAt: when,
  },
  report_delivery: {
    reportName: "Labor by Department",
    periodLabel: "October 2026",
    format: "PDF",
    url: "https://atlas.xos.test/rep/1",
  },
  export_ready: { exportName: "Vendors", expiresAt: when, url: "https://atlas.xos.test/exp/1" },
  import_finished: {
    importName: "Crew roster",
    written: 120,
    refused: 1,
    skipped: 3,
    url: "https://atlas.xos.test/imp/1",
  },
  dsar_received: {
    requestType: "Access",
    receivedAt: when,
    dueAt: new Date("2026-12-03T15:30:00Z"),
  },
};

/** Notification kinds seeded in supabase/migrations/0520_notifications.sql, the database side of the catalog. */
function seededKinds(): string[] {
  const sql = readFileSync(
    new URL("../../../supabase/migrations/0520_notifications.sql", import.meta.url),
    "utf8",
  );
  const block = sql.slice(sql.indexOf("from (values"), sql.indexOf(") as k (kind, category)"));
  return [...block.matchAll(/\('([a-z_]+\.[a-z_]+)', '[a-z_]+'\)/g)].map((m) => m[1] ?? "");
}

/** Template codes seeded in private.email_templates. */
function seededTemplates(): Map<string, boolean> {
  const sql = readFileSync(
    new URL("../../../supabase/migrations/0520_notifications.sql", import.meta.url),
    "utf8",
  );
  const block = sql.slice(
    sql.indexOf("insert into private.email_templates"),
    sql.indexOf("create table private.notification_templates"),
  );
  return new Map(
    [...block.matchAll(/\('([a-z_]+)', '[^']*(?:''[^']*)*', (true|false)\)/g)].map((m) => [
      m[1] ?? "",
      m[2] === "true",
    ]),
  );
}

describe("theme", () => {
  it("reads design values from packages/tokens, following references", () => {
    expect(color("accent-default")).toMatch(/^#[0-9A-F]{6}$/);
    expect(color("danger-text-on")).toBe(color("bg-canvas"));
    expect(space("space-16")).toBe("16px");
    expect(radius("radius-card")).toBe("8px");
    expect(stroke("stroke-hairline")).toBe("1px");
    expect(layout("layout-peek")).toBe("560px");
    expect(text("text-14").fontSize).toBe("14px");
  });

  it("refuses unknown tokens", () => {
    expect(() => color("no-such-color")).toThrow();
    expect(() => space("space-3")).toThrow();
    expect(() => text("text-99")).toThrow();
  });
});

describe("catalog", () => {
  it.each(locales)(
    "%s has a subject and body for every notification kind the database seeds",
    (locale) => {
      const kinds = seededKinds();
      expect(kinds.length).toBe(13);
      for (const kind of kinds) {
        expect(hasMessage(locale, `kinds.${kind}.subject`), `${locale} ${kind}`).toBe(true);
        expect(hasMessage(locale, `kinds.${kind}.body`), `${locale} ${kind}`).toBe(true);
      }
    },
  );

  it("has a template for every email template the database seeds, with the same transactional flag", () => {
    const seeded = seededTemplates();
    expect([...seeded.keys()].sort()).toEqual(Object.keys(templates).sort());
    for (const [code, transactional] of seeded) {
      expect(isTemplateCode(code)).toBe(true);
      if (isTemplateCode(code)) expect(templates[code].transactional, code).toBe(transactional);
    }
  });

  it("formats ICU plurals, selects and dates in the recipient's time zone", () => {
    expect(formatMessage("en-US", "digest.subject", { count: 1, orgName: "Northwind Live" })).toBe(
      "1 update from Northwind Live",
    );
    expect(formatMessage("es-US", "digest.subject", { count: 3, orgName: "Northwind Live" })).toBe(
      "3 novedades de Northwind Live",
    );
    expect(
      formatMessage("en-US", "kinds.approval.decided.subject", {
        title: "PO-7",
        decision: "approved",
      }),
    ).toBe("PO-7 was approved");
    const late = new Date("2026-11-04T02:00:00Z");
    expect(
      formatMessage(
        "en-US",
        "export_ready.body",
        { exportName: "Vendors", expiresAt: late },
        "America/New_York",
      ),
    ).toContain("November 3, 2026");
    expect(
      formatMessage(
        "en-US",
        "export_ready.body",
        { exportName: "Vendors", expiresAt: late },
        "UTC",
      ),
    ).toContain("November 4, 2026");
  });

  it("never ships a raw key or an unfilled argument", () => {
    expect(() => formatMessage("en-US", "kinds.no.such")).toThrow(/Missing email message/);
    expect(() => formatMessage("en-US", "invite.subject", { inviterName: "Alice" })).toThrow();
    expect(isTemplateCode("not_a_template")).toBe(false);
  });
});

describe.each(locales)("templates in %s", (locale) => {
  it.each(Object.keys(templates) as TemplateCode[])(
    "renders %s as semantic HTML with a plain-text part",
    async (code) => {
      const email = await renderEmail(code, samples[code] as never, {
        locale,
        sender,
        recipientName: "Dave",
        timeZone: "America/New_York",
      });
      expect(email.subject.length).toBeGreaterThan(0);
      expect(email.html).toContain(`lang="${locale}"`);
      expect(email.html).toMatch(/<h1[^>]*>/);
      expect(email.html).toContain("<main");
      expect(email.html).toContain("<footer");
      expect(email.html).toContain(sender.postalAddress);
      expect(email.html).not.toMatch(/kinds\.|common\.|\{[a-zA-Z]+\}/);
      expect(email.text).toContain(sender.postalAddress);
      expect(email.text).not.toContain("<");
      if (email.transactional) expect(email.html).not.toContain(sender.unsubscribeUrl);
      else expect(email.html).toContain(sender.unsubscribeUrl);
    },
  );
});

describe("rendering rules", () => {
  it("puts the notification body and action in both parts", async () => {
    const email = await renderEmail("notification", samples.notification, {
      locale: "en-US",
      sender,
      recipientName: "Dave",
    });
    expect(email.subject).toBe("Approval requested: Rigging rental");
    expect(email.text).toContain("Bob Okafor asked you to approve Rigging rental.");
    expect(email.html).toContain("https://atlas.xos.test/r/1");
  });

  it("refuses non-transactional email without an unsubscribe link", async () => {
    const { unsubscribeUrl: _dropped, ...noUnsubscribe } = sender;
    expect(_dropped).toBeDefined();
    await expect(
      renderEmail("digest", samples.digest, {
        locale: "en-US",
        sender: noUnsubscribe,
        recipientName: "Dave",
      }),
    ).rejects.toThrow(/unsubscribe/);
    await expect(
      renderEmail("invite", samples.invite, {
        locale: "en-US",
        sender: noUnsubscribe,
        recipientName: "Dave",
      }),
    ).resolves.toBeDefined();
  });

  it("refuses an empty digest and an invalid kind", async () => {
    await expect(
      renderEmail(
        "digest",
        { frequency: "daily", items: [] },
        { locale: "en-US", sender, recipientName: "Dave" },
      ),
    ).rejects.toThrow();
    await expect(
      renderEmail(
        "notification",
        { kind: "Bad Kind", args: {}, url: "https://x.test" },
        { locale: "en-US", sender, recipientName: "Dave" },
      ),
    ).rejects.toThrow(/Invalid notification kind/);
  });
});

function fakeResend(result: Awaited<ReturnType<ResendClient["emails"]["send"]>>) {
  const calls: { payload: unknown; options: unknown }[] = [];
  const client: ResendClient = {
    emails: {
      send: async (payload, options) => {
        calls.push({ payload, options });
        return result;
      },
    },
  };
  return { client, calls };
}

const message = {
  from: "XOS <n@xos.test>",
  to: "dave@northwind.test",
  subject: "S",
  html: "<p>B</p>",
  text: "B",
};

describe("transports", () => {
  it("records instead of sending", async () => {
    const transport = new RecordingTransport();
    await expect(transport.send(message)).resolves.toEqual({ providerMessageId: "recorded-1" });
    expect(transport.sent).toEqual([message]);
  });

  it("sends through Resend with an idempotency key and returns the message id", async () => {
    const { client, calls } = fakeResend({ data: { id: "re_msg_1" }, error: null, headers: null });
    const result = await new ResendTransport(client).send({
      ...message,
      idempotencyKey: "delivery-1",
      replyTo: "r@xos.test",
      headers: { A: "b" },
      tags: [{ name: "t", value: "v" }],
    });
    expect(result.providerMessageId).toBe("re_msg_1");
    expect(calls[0]?.payload).toMatchObject({
      to: ["dave@northwind.test"],
      text: "B",
      replyTo: "r@xos.test",
      headers: { A: "b" },
    });
    expect(calls[0]?.options).toEqual({ idempotencyKey: "delivery-1" });
  });

  it("surfaces a Resend error as a typed error", async () => {
    const { client } = fakeResend({
      data: null,
      error: { message: "Domain not verified", statusCode: 403, name: "validation_error" },
      headers: null,
    });
    await expect(new ResendTransport(client).send(message)).rejects.toBeInstanceOf(EmailSendError);
  });

  it("refuses recipients outside the allow-list before the provider sees them", async () => {
    const inner = new RecordingTransport();
    const guarded = new GuardedTransport(inner, {
      allowed: ["xos.test", "owner@example.org"],
      deliverToAny: false,
    });
    await expect(
      guarded.send({ ...message, to: "someone@realcompany.com" }),
    ).rejects.toBeInstanceOf(RecipientRefusedError);
    await expect(guarded.send({ ...message, to: "QA@xos.test" })).resolves.toBeDefined();
    await expect(guarded.send({ ...message, to: "owner@example.org" })).resolves.toBeDefined();
    expect(inner.sent.map((m) => m.to)).toEqual(["QA@xos.test", "owner@example.org"]);
    expect(guarded.name).toBe("guarded:record");
    expect(recipientAllowed("anyone@anywhere.com", { allowed: [], deliverToAny: true })).toBe(true);
  });
});

describe("environment", () => {
  it("records by default, so nothing is sent without explicit configuration", () => {
    const env = readEmailEnv({});
    expect(env.XOS_EMAIL_TRANSPORT).toBe("record");
    expect(env.XOS_EMAIL_DELIVER_TO_ANY).toBe(false);
    expect(createTransport(env).name).toBe("record");
  });

  it("requires a Resend key for the resend transport and names the variable", () => {
    expect(() => readEmailEnv({ XOS_EMAIL_TRANSPORT: "resend" })).toThrow(/RESEND_API_KEY/);
    expect(() =>
      readEmailEnv({ XOS_EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "not-a-key" }),
    ).toThrow(/RESEND_API_KEY/);
    expect(() => readEmailEnv({ XOS_EMAIL_TRANSPORT: "smtp" })).toThrow(/XOS_EMAIL_TRANSPORT/);
  });

  it("wraps Resend in the recipient guard with the parsed allow-list", async () => {
    const env = readEmailEnv({
      XOS_EMAIL_TRANSPORT: "resend",
      RESEND_API_KEY: "re_testkey123",
      XOS_EMAIL_ALLOWLIST: " XOS.test , owner@example.org ",
    });
    expect(env.XOS_EMAIL_ALLOWLIST).toEqual(["xos.test", "owner@example.org"]);
    const { client, calls } = fakeResend({ data: { id: "re_msg_2" }, error: null, headers: null });
    let keyUsed = "";
    const transport = createTransport(env, (key) => {
      keyUsed = key;
      return client;
    });
    expect(transport.name).toBe("guarded:resend");
    expect(keyUsed).toBe("re_testkey123");
    await expect(
      transport.send({ ...message, to: "someone@realcompany.com" }),
    ).rejects.toBeInstanceOf(RecipientRefusedError);
    expect(calls).toHaveLength(0);
  });
});

describe("sendEmail", () => {
  it("renders, adds one-click unsubscribe headers and keys the send by delivery", async () => {
    const transport = new RecordingTransport();
    const result = await sendEmail({
      transport,
      template: "notification",
      props: samples.notification,
      locale: "es-US",
      sender,
      recipientName: "Dave",
      from: "Northwind Live <notifications@northwind.test>",
      to: "dave@northwind.test",
      replyTo: "reply+sig@in.xos.test",
      deliveryId: "d-1",
    });
    expect(result.providerMessageId).toBe("recorded-1");
    const sent = transport.sent[0];
    expect(sent?.subject).toBe("Aprobación solicitada: Rigging rental");
    expect(sent?.headers?.["List-Unsubscribe"]).toBe(`<${sender.unsubscribeUrl}>`);
    expect(sent?.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(sent?.idempotencyKey).toBe("delivery-d-1");
    expect(sent?.replyTo).toBe("reply+sig@in.xos.test");
    expect(sent?.tags).toEqual([
      { name: "template", value: "notification" },
      { name: "delivery_id", value: "d-1" },
    ]);
  });

  it("sends transactional email without unsubscribe headers", async () => {
    const transport = new RecordingTransport();
    await sendEmail({
      transport,
      template: "invite",
      props: samples.invite,
      locale: "en-US",
      sender,
      recipientName: "Quinn",
      from: "a@xos.test",
      to: "q@xos.test",
    });
    expect(transport.sent[0]?.headers).toEqual({});
    expect(transport.sent[0]?.idempotencyKey).toBeUndefined();
  });
});
