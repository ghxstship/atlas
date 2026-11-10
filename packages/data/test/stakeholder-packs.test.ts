import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  mailpitMailer,
  resendMailer,
  type ReportEmail,
  type ReportMailer,
} from "../src/report-deliveries.ts";
import {
  addPackGrant,
  createStakeholderPack,
  MAX_PACK_GRANTS,
  openStakeholderPack,
  packAsksForCode,
  packEmailLinks,
  packExpiryText,
  packFileTicket,
  parsePackGrants,
  parsePackRefusal,
  readStakeholderPack,
  runPackDeliveries,
  supabasePackDeliveryStore,
  signPackItem,
  unsubscribeStakeholderPack,
  type MintedPackLink,
  type PackDeliveryStore,
  type ComposePackEmail,
} from "../src/stakeholder-packs.ts";
import { errorResponse, fakeClient, okResponse, type Response } from "./fake-client.ts";

const TOKEN = `xpkl_${"ab".repeat(32)}`;
const GRANT = `xpkg_${"cd".repeat(32)}`;
const UNSUB = `xpku_${"ef".repeat(32)}`;

function withPublic(queues: Record<string, Response[]>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db = {
    schema: (name: string) => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn: `${name}.${fn}`, args });
        const next = queues[`rpc:${name}.${fn}`]?.shift();
        if (!next) throw new Error(`no queued response for rpc:${name}.${fn}`);
        return next;
      },
    }),
  } as unknown as XosClient;
  return { db, calls };
}

describe("the device's grant cookie", () => {
  it("keeps up to 8 well-formed grants, newest first", () => {
    const others = Array.from({ length: 9 }, (_, i) => `xpkg_${String(i).repeat(64)}`);
    const value = addPackGrant(others.join(" "), GRANT);
    const grants = parsePackGrants(value);
    expect(grants).toHaveLength(MAX_PACK_GRANTS);
    expect(grants[0]).toBe(GRANT);
    expect(parsePackGrants("nonsense xpkg_short")).toEqual([]);
    expect(parsePackGrants(null)).toEqual([]);
  });

  it("does not repeat a grant it already holds", () => {
    expect(parsePackGrants(addPackGrant(GRANT, GRANT))).toEqual([GRANT]);
  });

  it("drops grants the database says are dead, so a swap never pushes out another pack's", () => {
    const other = `xpkg_${"1".repeat(64)}`;
    const swapped = `xpkg_${"2".repeat(64)}`;
    expect(parsePackGrants(addPackGrant(`${swapped} ${other}`, GRANT, [swapped]))).toEqual([
      GRANT,
      other,
    ]);
    // Opening one pack again and again never fills the cookie.
    let cookie = other;
    for (let i = 0; i < 12; i += 1) {
      const fresh = `xpkg_${String(i % 10).repeat(63)}a`;
      cookie = addPackGrant(
        cookie,
        fresh,
        parsePackGrants(cookie).filter((g) => g !== other),
      );
    }
    expect(parsePackGrants(cookie)).toContain(other);
    expect(parsePackGrants(cookie)).toHaveLength(2);
  });
});

describe("refusals", () => {
  it("maps anything unknown to pack_link_invalid and knows the ones the form answers", () => {
    expect(parsePackRefusal("pack_locked")).toBe("pack_locked");
    expect(parsePackRefusal("nonsense")).toBe("pack_link_invalid");
    expect(packAsksForCode("pack_grant")).toBe(true);
    expect(packAsksForCode("pack_access_code")).toBe(true);
    expect(packAsksForCode("pack_locked")).toBe(false);
  });
});

describe("the signed-in side", () => {
  it("leaves out an empty message and note and maps a refusal", async () => {
    const { db: client, calls } = fakeClient({
      "rpc:create_stakeholder_pack": [okResponse("pack-1")],
    });
    const made = await createStakeholderPack(client, {
      projectId: "p",
      name: "Client pack",
      expiresAt: "2026-12-01T00:00:00Z",
      message: null,
      note: null,
    });
    expect(made).toEqual({ ok: true, data: "pack-1" });
    expect(JSON.stringify(calls[0]?.steps)).not.toContain("p_message");
    const refused = fakeClient({
      "rpc:create_stakeholder_pack": [
        errorResponse(
          "XR001",
          "stakeholder_pack_expiry_range: no",
          "stakeholder_pack_expiry_range",
        ),
      ],
    });
    const result = await createStakeholderPack(refused.db, {
      projectId: "p",
      name: "x",
      expiresAt: "x",
      message: null,
      note: null,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "stakeholder_pack_expiry_range" },
    });
  });
});

describe("the anonymous side", () => {
  it("never calls the database for a token of the wrong shape", async () => {
    const { db, calls } = withPublic({});
    expect(
      await openStakeholderPack(db, {
        token: "nope",
        accessCode: "123456",
        grants: [],
        clientAddress: null,
      }),
    ).toEqual({
      ok: true,
      data: { refused: true, reason: "pack_link_invalid" },
    });
    expect(
      await readStakeholderPack(db, { token: "nope", grants: [], clientAddress: null }),
    ).toMatchObject({ data: { refused: true } });
    expect(
      await unsubscribeStakeholderPack(db, { token: TOKEN, clientAddress: null }),
    ).toMatchObject({ data: { refused: true } });
    expect(calls).toHaveLength(0);
  });

  it("opens with a code or a grant, and passes the address relayed", async () => {
    const { db, calls } = withPublic({
      "rpc:api_public.open_stakeholder_pack": [
        okResponse({
          status: "ok",
          grant: GRANT,
          grant_expires_at: "2026-12-01T00:00:00Z",
          dead_grants: [`xpkg_${"f".repeat(64)}`],
        }),
        okResponse({ status: "refused", reason: "pack_access_code_required" }),
      ],
    });
    expect(
      await openStakeholderPack(db, {
        token: TOKEN,
        accessCode: "123456",
        grants: [],
        clientAddress: "203.0.113.5",
      }),
    ).toEqual({
      ok: true,
      data: {
        refused: false,
        grant: GRANT,
        grantExpiresAt: "2026-12-01T00:00:00Z",
        deadGrants: [`xpkg_${"f".repeat(64)}`],
      },
    });
    expect(calls[0]?.args).toMatchObject({
      p_access_code: "123456",
      p_client_address: "203.0.113.5",
      p_grants: null,
    });
    expect(
      await openStakeholderPack(db, {
        token: TOKEN,
        accessCode: null,
        grants: [GRANT],
        clientAddress: null,
      }),
    ).toEqual({
      ok: true,
      data: { refused: true, reason: "pack_access_code_required" },
    });
    expect(calls[1]?.args).toMatchObject({ p_grants: [GRANT] });
  });

  it("reads a pack's meta and items and nothing else", async () => {
    const { db } = withPublic({
      "rpc:api_public.stakeholder_pack": [
        okResponse({
          status: "ok",
          meta: {
            project_name: "Show",
            time_zone: "America/New_York",
            brand_name: "Northwind",
            pack_name: "Client pack",
            expires_at: "2026-12-01T00:00:00Z",
            brand_suppress_powered_by: true,
          },
          recipient_name: "Cleo",
          items: [
            {
              id: "i",
              title: "Plan",
              kind: "File",
              available: true,
              requires_acknowledgement: true,
              signed_at: null,
            },
          ],
        }),
      ],
    });
    const read = await readStakeholderPack(db, {
      token: TOKEN,
      grants: [GRANT],
      clientAddress: null,
    });
    expect(read).toMatchObject({
      ok: true,
      data: {
        refused: false,
        recipientName: "Cleo",
        meta: { timeZone: "America/New_York", suppressPoweredBy: true },
        items: [{ id: "i", kind: "File", requiresAcknowledgement: true, signedAt: null }],
      },
    });
  });

  it("answers a ticket or its refusal, and a repeat acknowledgement as already_signed", async () => {
    const { db } = withPublic({
      "rpc:api_public.stakeholder_pack_file": [
        okResponse([
          { refusal: null, ticket: "xdlt_1", filename: "a.pdf", content_type: "application/pdf" },
        ]),
        okResponse([{ refusal: "pack_item_unavailable", ticket: null }]),
      ],
      "rpc:api_public.sign_stakeholder_pack_item": [
        okResponse({ status: "refused", reason: "already_signed", signed_at: "x" }),
      ],
    });
    const input = { token: TOKEN, grants: [GRANT], itemId: "i", clientAddress: null };
    expect(await packFileTicket(db, input)).toMatchObject({
      data: { refused: false, ticket: "xdlt_1" },
    });
    expect(await packFileTicket(db, input)).toMatchObject({
      data: { refused: true, reason: "pack_item_unavailable" },
    });
    expect(await signPackItem(db, { ...input, signerName: "Cleo" })).toMatchObject({
      data: { refused: true, reason: "already_signed" },
    });
  });

  it("unsubscribes with an unsubscribe token", async () => {
    const { db } = withPublic({
      "rpc:api_public.unsubscribe_stakeholder_pack": [
        okResponse({ status: "ok", unsubscribed_at: "x" }),
      ],
    });
    expect(await unsubscribeStakeholderPack(db, { token: UNSUB, clientAddress: null })).toEqual({
      ok: true,
      data: { refused: false },
    });
  });
});

/** A stand-in for report-run's branded composer (packages/platform edge/report-email.ts, tested there). */
const compose: ComposePackEmail = async (link, links, mailEnv) => ({
  to: link.email.recipientEmail,
  toName: link.email.recipientName,
  subject: `${link.email.senderName} shared ${link.email.packName}`,
  text: `${links.url}\n${links.stopUrl}\n${mailEnv.postalAddress}`,
  html: "<p>pack</p>",
  headers: { "List-Unsubscribe": `<${links.oneClickUrl}>` },
});

const minted: MintedPackLink = {
  token: TOKEN,
  unsubscribeToken: UNSUB,
  expiresAt: "2026-07-08T03:59:00Z",
  email: {
    recipientName: "Cleo",
    recipientEmail: "cleo@client.test",
    locale: "en-US",
    orgId: "org-1",
    orgName: "Northwind",
    brandName: "Northwind Live",
    whiteLabel: false,
    brandSenderName: null,
    replyTo: null,
    logoPath: null,
    accentHex: null,
    suppressPoweredBy: false,
    packName: "Client pack",
    message: "Welcome <b>",
    itemTitles: ["Plan", "Show clock"],
    senderName: "Carol",
    expiresAt: "2026-07-08T03:59:00Z",
    timeZone: "America/New_York",
  },
};

const env = {
  appUrl: "https://atlas.test",
  postalAddress: "1 Main St, Miami FL",
  apiUrl: "https://api.test",
};

describe("the pack email's links", () => {
  it("puts the pack and the page that asks before it stops on Atlas, and the one-click stop on the API", () => {
    expect(packEmailLinks(minted, env)).toEqual({
      url: `https://atlas.test/share/pack/${TOKEN}`,
      stopUrl: `https://atlas.test/share/pack/unsubscribe/${UNSUB}`,
      oneClickUrl: `https://api.test/functions/v1/email-unsubscribe?token=${UNSUB}`,
    });
  });

  it("shows the expiry in the project's zone", () => {
    const eastern = packExpiryText("2026-07-08T03:59:00Z", "en-US", "America/New_York");
    expect(eastern).toContain("Jul 7, 2026");
    expect(packExpiryText("2026-07-08T03:59:00Z", "en-US", "Asia/Tokyo")).toContain("Jul 8, 2026");
  });
});

function fakeStore(over: Partial<PackDeliveryStore> = {}) {
  const finished: unknown[] = [];
  const jobs: unknown[] = [];
  const store: PackDeliveryStore = {
    claim: async () => [{ jobId: "j", deliveryId: "d" }],
    mint: async () => minted,
    finish: async (id, outcome) => void finished.push({ id, outcome }),
    finishJob: async (id, ok, error) => {
      jobs.push({ id, ok, error });
      return ok ? "Succeeded" : "Queued";
    },
    ...over,
  };
  return { store, finished, jobs };
}

describe("the pack.deliver worker", () => {
  const sent: ReportEmail[] = [];
  const mailer: ReportMailer = {
    name: "fake",
    send: async (email) => {
      sent.push(email);
      return { messageId: "m-1" };
    },
  };
  const run = (store: PackDeliveryStore, m: ReportMailer = mailer, e = env) =>
    runPackDeliveries({ store, mailer: m, compose, env: e, worker: "w" });

  it("claims, mints, sends and finishes", async () => {
    const { store, finished, jobs } = fakeStore();
    sent.length = 0;
    expect(await run(store)).toEqual([{ jobId: "j", deliveryId: "d", status: "Sent" }]);
    expect(sent[0]?.text).toContain(`https://atlas.test/share/pack/${TOKEN}`);
    expect(sent[0]?.headers?.["List-Unsubscribe"]).toBe(
      `<https://api.test/functions/v1/email-unsubscribe?token=${UNSUB}>`,
    );
    expect(finished).toEqual([{ id: "d", outcome: { sent: true, messageId: "m-1" } }]);
    expect(jobs).toEqual([{ id: "j", ok: true, error: null }]);
  });

  it("marks a delivery the database skipped", async () => {
    const { store, finished } = fakeStore({ mint: async () => null });
    expect(await run(store)).toEqual([{ jobId: "j", deliveryId: "d", status: "Skipped" }]);
    expect(finished).toEqual([]);
  });

  it("fails with the reason when the app address or postal address is unset, and never mints", async () => {
    let minting = 0;
    const base = { mint: async () => ((minting += 1), minted) };
    const noApp = fakeStore(base);
    expect(
      (await run(noApp.store, mailer, { ...env, appUrl: undefined as unknown as string }))[0]
        ?.error,
    ).toContain("XOS_APP_URL");
    const noPostal = fakeStore(base);
    expect(
      (
        await run(noPostal.store, mailer, { ...env, postalAddress: undefined as unknown as string })
      )[0]?.error,
    ).toContain("XOS_POSTAL_ADDRESS");
    expect(minting).toBe(0);
  });

  it("revokes a failed attempt's link and says whether the job retries", async () => {
    const failing: ReportMailer = {
      name: "x",
      send: async () => Promise.reject(new Error("bounced")),
    };
    const retrying = fakeStore();
    expect((await run(retrying.store, failing))[0]).toMatchObject({
      status: "Queued",
      error: "bounced",
    });
    expect(retrying.finished).toEqual([
      { id: "d", outcome: { sent: false, error: "bounced", willRetry: true } },
    ]);
    const final = fakeStore({ finishJob: async () => "Failed" });
    expect((await run(final.store, failing))[0]).toMatchObject({ status: "Failed" });
    expect(final.finished).toEqual([
      { id: "d", outcome: { sent: false, error: "bounced", willRetry: false } },
    ]);
  });
});

describe("the mailers with a pack email", () => {
  const email: ReportEmail = {
    to: "a@b.test",
    toName: "A",
    subject: "S",
    text: "T",
    html: "<p>T</p>",
    headers: { "List-Unsubscribe": "<u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };

  it("Mailpit sends the headers and no Attachments", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ ID: "m" }), { status: 200 });
    }) as unknown as typeof fetch;
    await mailpitMailer("http://127.0.0.1:1", { email: "x@y.test", name: "X" }, fetchImpl).send(
      email,
    );
    expect(body["Headers"]).toEqual(email.headers);
    expect(body).not.toHaveProperty("Attachments");
  });

  it("Resend passes the headers and omits attachments", async () => {
    let payload: Record<string, unknown> = {};
    const client = {
      emails: {
        send: async (p: Record<string, unknown>) => {
          payload = p;
          return { data: { id: "r" }, error: null };
        },
      },
    };
    await resendMailer(client as never, "x@y.test", () => true).send(email);
    expect(payload["headers"]).toEqual(email.headers);
    expect(payload).not.toHaveProperty("attachments");
  });
});

describe("the pack delivery store", () => {
  it("reads the org's email brand the mint answers while white label is in force", async () => {
    const email = {
      recipient_name: "Cleo",
      recipient_email: "cleo@client.test",
      locale: "en-US",
      org_id: "org-1",
      org_name: "Northwind",
      brand_name: "Northwind Presents",
      white_label: true,
      brand_sender_name: "Northwind Client Desk",
      reply_to: "clients@northwind.test",
      logo_path: "org-1/logo.png",
      accent_hex: "#0B5FFF",
      suppress_powered_by: true,
      pack_name: "Client pack",
      message: null,
      item_titles: ["Plan"],
      sender_name: null,
      expires_at: "2026-07-08T03:59:00Z",
      time_zone: "America/New_York",
    };
    const client = {
      schema: () => ({
        rpc: async () => ({
          data: [
            { token: TOKEN, unsubscribe_token: UNSUB, expires_at: "2026-07-08T03:59:00Z", email },
          ],
          error: null,
        }),
      }),
    } as unknown as Parameters<typeof supabasePackDeliveryStore>[0];
    const link = await supabasePackDeliveryStore(client).mint("d");
    expect(link?.email).toMatchObject({
      orgId: "org-1",
      brandName: "Northwind Presents",
      whiteLabel: true,
      brandSenderName: "Northwind Client Desk",
      replyTo: "clients@northwind.test",
      logoPath: "org-1/logo.png",
      accentHex: "#0B5FFF",
      suppressPoweredBy: true,
      senderName: null,
    });
  });
});
