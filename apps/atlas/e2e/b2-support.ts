import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mailpitMailer } from "@xos/data/report-deliveries";
import {
  runPackDeliveries,
  supabasePackDeliveryStore,
  type PackEmailCopy,
} from "@xos/data/stakeholder-packs";
import { expect, type APIRequestContext } from "@playwright/test";

/**
 * Shared steps for the B2 journeys (RRR-226, ADR 0141). One pass of the pack.deliver worker runs here with the service
 * role of the local stack, the same code report-run runs, with fake addresses, and the mail lands in its Mailpit.
 * E2E_SUPABASE_URL, E2E_SUPABASE_SERVICE_KEY and E2E_INBUCKET_URL name the local stack only.
 */

export function localStack(): { client: SupabaseClient; inbox: string; url: string } {
  const url = process.env["E2E_SUPABASE_URL"];
  const key = process.env["E2E_SUPABASE_SERVICE_KEY"];
  const inbox = process.env["E2E_INBUCKET_URL"];
  if (!url || !key || !inbox) {
    throw new Error("Set E2E_SUPABASE_URL, E2E_SUPABASE_SERVICE_KEY and E2E_INBUCKET_URL.");
  }
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error("Local stack only.");
  return {
    client: createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }),
    inbox,
    url,
  };
}

const fill = (template: string, values: Readonly<Record<string, string>>) =>
  template.replace(/\{(\w+)\}/g, (all, name: string) => values[name] ?? all);

const COPY: PackEmailCopy = {
  subject: (v) => fill("{sender} shared {pack} with you", v),
  intro: (v) => fill("{sender} shared {pack} with you.", v),
  message: (v) => fill("Their message: {message}", v),
  items: (v) => fill("In this pack: {items}", v),
  open: (v) => fill("Open the pack: {url}", v),
  expires: (v) => fill("This link works until {date}.", v),
  code: () => "The access code never comes by email.",
  sentBy: (v) => fill("Sent by {org}, {address}.", v),
  stop: (v) => fill("Stop these emails: {url}", v),
};

/** One pass of the worker, as report-run makes it, against the local inbox. */
export async function deliverPacks(appUrl: string): Promise<void> {
  const { client, inbox, url } = localStack();
  const results = await runPackDeliveries({
    store: supabasePackDeliveryStore(client),
    mailer: mailpitMailer(inbox, { email: "reports@xos.localhost", name: "XOS" }),
    copy: async () => COPY,
    env: { appUrl, postalAddress: "100 Harbor Way, Miami, FL 33132", apiUrl: url },
    worker: `e2e:${crypto.randomUUID()}`,
  });
  expect(results.filter((r) => r.status === "Failed")).toEqual([]);
}

export interface PackMail {
  readonly text: string;
  readonly html: string;
  readonly headers: Readonly<Record<string, readonly string[]>>;
  readonly attachments: number;
}

/** The latest mail to an address, read from Mailpit, waiting for it to arrive. */
export async function latestMail(request: APIRequestContext, to: string): Promise<PackMail> {
  const { inbox } = localStack();
  let id = "";
  await expect(async () => {
    const found = (await (
      await request.get(`${inbox}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)
    ).json()) as { messages?: { ID: string }[] };
    id = found.messages?.[0]?.ID ?? "";
    expect(id).not.toBe("");
  }).toPass({ timeout: 20_000 });
  const message = (await (await request.get(`${inbox}/api/v1/message/${id}`)).json()) as {
    Text: string;
    HTML: string;
    Attachments?: unknown[];
  };
  const headers = (await (
    await request.get(`${inbox}/api/v1/message/${id}/headers`)
  ).json()) as Record<string, string[]>;
  return {
    text: message.Text,
    html: message.HTML,
    headers,
    attachments: message.Attachments?.length ?? 0,
  };
}

/** The pack path in a mail, and its stop-email path. */
export function mailLinks(mail: PackMail): {
  pack: string;
  stop: string;
  unsubscribeToken: string;
} {
  const pack = /https?:\/\/[^\s]+(\/share\/pack\/xpkl_[0-9a-f]{64})/.exec(mail.text)?.[1];
  const stop = /https?:\/\/[^\s]+(\/share\/pack\/unsubscribe\/(xpku_[0-9a-f]{64}))/.exec(mail.text);
  if (!pack || !stop?.[1] || !stop[2]) throw new Error("The pack email has no links.");
  return { pack, stop: stop[1], unsubscribeToken: stop[2] };
}
