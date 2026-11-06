import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mailpitMailer } from "@xos/data/report-deliveries";
import {
  runPackDeliveries,
  supabasePackDeliveryStore,
  type PackEmailCopy,
} from "@xos/data/stakeholder-packs";
import { expect, type APIRequestContext } from "@playwright/test";
import pg from "pg";

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

const DATABASE_URL =
  process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";

/**
 * One statement against the local stack. With `person`, it runs as that person under the authenticated role, the way
 * Atlas reaches the database, so row level security and the RPCs' own checks apply; without, as postgres.
 */
export async function sql<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
  person?: string,
): Promise<T[]> {
  if (!/@(127\.0\.0\.1|localhost):/.test(DATABASE_URL)) throw new Error("Local stack only.");
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query("begin");
    if (person) {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: person, role: "authenticated" }),
      ]);
      await client.query("set local role authenticated");
    }
    const result = await client.query(text, params);
    await client.query("commit");
    return result.rows as T[];
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

/** The person of an account, by email. */
export async function personOf(email: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `select p.id from app.people p join auth.users u on u.id = p.user_id where u.email = $1`,
    [email],
  );
  return row?.id as string;
}

/** A project's id, by its org's slug and its key. */
export async function projectOf(slug: string, key: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `select p.id from app.projects p join app.organizations o on o.id = p.org_id
      where o.slug = $1 and p.project_key = $2`,
    [slug, key],
  );
  return row?.id as string;
}

/** A stored, scanned file on a subject, classified as asked; answers the attachment's id. */
export async function storedFile(input: {
  readonly person: string;
  readonly subjectTable: string;
  readonly subjectId: string;
  readonly name: string;
  readonly classification?: "Public" | "Internal" | "Confidential";
}): Promise<string> {
  const bytes = Buffer.from("%PDF-1.4\n% a journey file\n%%EOF\n");
  const [upload] = await sql<{ attachment_version_id: string; object_name: string }>(
    `select u.attachment_version_id, u.object_name
       from app.begin_attachment_upload($1, $2::uuid, $3, 'application/pdf', $4) u`,
    [input.subjectTable, input.subjectId, input.name, bytes.length],
    input.person,
  );
  const stored = await localStack()
    .client.storage.from("attachments")
    .upload(upload?.object_name as string, bytes, { contentType: "application/pdf" });
  expect(stored.error).toBeNull();
  await sql(
    `select app.complete_attachment_upload($1::uuid, $2)`,
    [upload?.attachment_version_id, "ab".repeat(32)],
    input.person,
  );
  await sql(`select app.record_attachment_scan($1::uuid, true)`, [upload?.attachment_version_id]);
  const [attachment] = await sql<{ id: string }>(
    `select attachment_id as id from app.attachment_versions where id = $1::uuid`,
    [upload?.attachment_version_id],
  );
  const id = attachment?.id as string;
  if (input.classification) {
    await sql(
      `update app.attachments set classification = $1::app.data_classification where id = $2::uuid`,
      [input.classification, id],
      input.person,
    );
  }
  return id;
}

/** A display link on a new running order of the project, as the person. */
export async function displayLink(person: string, project: string, name: string): Promise<string> {
  const [order] = await sql<{ id: string }>(
    `insert into app.run_of_show (project_id, name, show_date) values ($1::uuid, $2, current_date + 10) returning id`,
    [project, name],
    person,
  );
  const [link] = await sql<{ live_link_id: string }>(
    `select d.live_link_id from app.create_display_link($1::uuid, now() + interval '30 days') d`,
    [order?.id],
    person,
  );
  return link?.live_link_id as string;
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
