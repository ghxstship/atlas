import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { billingStore, handleStripeWebhook, supabaseDb } from "@xos/platform";
import { loadPlanRegistry } from "@xos/schemas/plans";
import { serviceClient } from "./a79-support";

/**
 * A local fake of Stripe for the billing journey (ADR 0033 decision 59). Atlas reaches it
 * through STRIPE_API_URL with the fake test key that playwright.config.ts and CI give the server; nothing
 * here reaches Stripe. It answers the API calls Checkout and the customer portal make (prices by lookup key,
 * Checkout sessions, their expiry, portal configurations and sessions) and serves a hosted Checkout page
 * and a portal page. Paying on the Checkout page delivers what Stripe would: `checkout.session.completed`
 * and `customer.subscription.created`, signed with a webhook secret made up for the run and applied through
 * the platform's webhook handler against the local stack, as the stripe-webhook Edge Function does.
 */

/** The fake Stripe key the journey server runs with: allowlisted as fake in .gitleaks.toml. */
export const FAKE_STRIPE_KEY = "sk_test_abcdefghij";

/** Where the fake listens; playwright.config.ts points Atlas at the same origin. */
export const FAKE_STRIPE_PORT = Number(process.env["E2E_STRIPE_PORT"] ?? 12111);
export const FAKE_STRIPE_URL = `http://127.0.0.1:${String(FAKE_STRIPE_PORT)}`;

interface FakeSession {
  id: string;
  status: "open" | "complete" | "expired";
  orgId: string;
  customer: string | null;
  customerEmail: string | null;
  trialEnd: number | null;
  lineItems: { price: string; quantity: number }[];
  successUrl: string;
  cancelUrl: string;
  expiresAt: number;
}

export interface FakeStripe {
  readonly url: string;
  readonly sessions: ReadonlyMap<string, FakeSession>;
  /** Every API request Atlas made, in order. */
  readonly requests: readonly { method: string; path: string }[];
  close(): Promise<void>;
}

const registry = loadPlanRegistry();
const now = () => Math.floor(Date.now() / 1000);

/** The fake price id of a lookup key, and back. */
const priceId = (lookupKey: string) => `price_fake_${lookupKey}`;
const lookupKeyOf = (price: string) => price.replace(/^price_fake_/, "");

function knownLookupKeys(): Set<string> {
  const keys = new Set<string>();
  for (const plan of registry.plans) {
    if (plan.stripe)
      keys.add(plan.stripe.monthlyPriceLookupKey).add(plan.stripe.annualPriceLookupKey);
    if (plan.extraSeat) {
      keys.add(plan.extraSeat.monthlyPriceLookupKey).add(plan.extraSeat.annualPriceLookupKey);
    }
  }
  for (const addon of registry.addons) keys.add(addon.priceLookupKey);
  return keys;
}

/** Stripe's signature scheme: HMAC-SHA256 of `<timestamp>.<body>` under the endpoint secret. */
function sign(body: string, secret: string): string {
  const timestamp = now();
  const digest = createHmac("sha256", secret)
    .update(`${String(timestamp)}.${body}`)
    .digest("hex");
  return `t=${String(timestamp)},v1=${digest}`;
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fake Stripe</title></head><body><main>${body}</main></body></html>`,
  );
}

function escape(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );
}

function missing(response: ServerResponse, what: string): void {
  json(response, 404, {
    error: { type: "invalid_request_error", code: "resource_missing", message: `No such ${what}` },
  });
}

export async function startFakeStripe(port: number = FAKE_STRIPE_PORT): Promise<FakeStripe> {
  const webhookSecret = `whsec_${randomBytes(24).toString("hex")}`;
  const sessions = new Map<string, FakeSession>();
  const portals = new Map<string, { customer: string; returnUrl: string }>();
  const requests: { method: string; path: string }[] = [];
  const lookupKeys = knownLookupKeys();
  let next = 1;
  const store = billingStore(supabaseDb(serviceClient()));
  const base = `http://127.0.0.1:${String(port)}`;

  async function deliver(type: string, object: unknown): Promise<void> {
    const body = JSON.stringify({
      id: `evt_fake${String(next++)}`,
      object: "event",
      type,
      livemode: false,
      created: now(),
      api_version: "2026-09-30",
      data: { object },
    });
    const outcome = await handleStripeWebhook({
      rawBody: body,
      signature: sign(body, webhookSecret),
      webhookSecret,
      livemode: false,
      registry,
      store,
    });
    if (outcome.outcome !== "applied") {
      throw new Error(`The webhook did not apply ${type}: ${JSON.stringify(outcome)}`);
    }
  }

  async function pay(session: FakeSession): Promise<void> {
    const customer = session.customer ?? `cus_fake${String(next++)}`;
    const subscription = `sub_fake${String(next++)}`;
    session.status = "complete";
    session.customer = customer;
    await deliver("checkout.session.completed", {
      id: session.id,
      object: "checkout.session",
      mode: "subscription",
      status: "complete",
      payment_status: session.trialEnd === null ? "paid" : "no_payment_required",
      customer,
      subscription,
      metadata: { org_id: session.orgId },
    });
    const periodEnd = session.trialEnd ?? now() + 30 * 86_400;
    await deliver("customer.subscription.created", {
      id: subscription,
      object: "subscription",
      customer,
      status: session.trialEnd === null ? "active" : "trialing",
      metadata: { org_id: session.orgId },
      items: {
        object: "list",
        data: session.lineItems.map((item, i) => ({
          id: `si_fake${String(i)}`,
          quantity: item.quantity,
          current_period_end: periodEnd,
          price: { id: item.price, lookup_key: lookupKeyOf(item.price) },
        })),
      },
    });
  }

  async function api(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    requests.push({ method: request.method ?? "GET", path: url.pathname });
    const route = `${request.method ?? "GET"} ${url.pathname}`;
    if (route === "GET /v1/prices") {
      const key = url.searchParams.get("lookup_keys[0]") ?? "";
      json(response, 200, {
        object: "list",
        url: "/v1/prices",
        has_more: false,
        data: lookupKeys.has(key)
          ? [{ id: priceId(key), object: "price", lookup_key: key, active: true }]
          : [],
      });
      return;
    }
    if (route === "POST /v1/checkout/sessions") {
      const form = await readForm(request);
      const id = `cs_test_Fake${String(next++)}`;
      const lineItems: FakeSession["lineItems"] = [];
      for (let i = 0; form.has(`line_items[${String(i)}][price]`); i += 1) {
        lineItems.push({
          price: form.get(`line_items[${String(i)}][price]`) ?? "",
          quantity: Number(form.get(`line_items[${String(i)}][quantity]`) ?? "1"),
        });
      }
      const trialEnd = form.get("subscription_data[trial_end]");
      const session: FakeSession = {
        id,
        status: "open",
        orgId: form.get("metadata[org_id]") ?? "",
        customer: form.get("customer"),
        customerEmail: form.get("customer_email"),
        trialEnd: trialEnd === null ? null : Number(trialEnd),
        lineItems,
        successUrl: form.get("success_url") ?? "",
        cancelUrl: form.get("cancel_url") ?? "",
        expiresAt: now() + 86_400,
      };
      sessions.set(id, session);
      json(response, 200, {
        id,
        object: "checkout.session",
        mode: form.get("mode"),
        status: "open",
        url: `${base}/pay/${id}`,
        expires_at: session.expiresAt,
      });
      return;
    }
    const sessionPath = /^\/v1\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)(\/expire)?$/.exec(
      url.pathname,
    );
    if (sessionPath) {
      const session = sessions.get(sessionPath[1] ?? "");
      if (!session) return missing(response, "checkout session");
      if (sessionPath[2] && request.method === "POST") {
        if (session.status !== "open") {
          json(response, 400, {
            error: { type: "invalid_request_error", message: "Only open sessions can be expired" },
          });
          return;
        }
        session.status = "expired";
      }
      json(response, 200, { id: session.id, object: "checkout.session", status: session.status });
      return;
    }
    if (route === "GET /v1/billing_portal/configurations") {
      json(response, 200, { object: "list", url: url.pathname, has_more: false, data: [] });
      return;
    }
    if (route === "POST /v1/billing_portal/sessions") {
      const form = await readForm(request);
      const id = `bps_fake${String(next++)}`;
      portals.set(id, {
        customer: form.get("customer") ?? "",
        returnUrl: form.get("return_url") ?? "",
      });
      json(response, 200, { id, object: "billing_portal.session", url: `${base}/portal/${id}` });
      return;
    }
    missing(response, `route ${route}`);
  }

  async function hosted(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const payPage = /^\/pay\/(cs_test_[A-Za-z0-9]+)$/.exec(url.pathname);
    if (payPage) {
      const session = sessions.get(payPage[1] ?? "");
      if (!session) return missing(response, "checkout session");
      if (request.method === "POST") {
        if (session.status !== "open") {
          html(response, `<h1>This checkout is ${session.status}</h1>`);
          return;
        }
        await pay(session);
        response.writeHead(303, { Location: session.successUrl });
        response.end();
        return;
      }
      const items = session.lineItems
        .map((item) => `<li>${escape(lookupKeyOf(item.price))} x ${String(item.quantity)}</li>`)
        .join("");
      html(
        response,
        `<h1>Fake Stripe Checkout</h1>
<p>Session ${escape(session.id)} is ${session.status}.</p>
<ul aria-label="Line items">${items}</ul>
<p>${session.trialEnd === null ? "Charged today." : `Trial until ${new Date(session.trialEnd * 1000).toISOString().slice(0, 10)}.`}</p>
<p>Customer: ${escape(session.customer ?? session.customerEmail ?? "new")}</p>
<form method="post"><button type="submit">Pay and subscribe</button></form>
<p><a href="${escape(session.cancelUrl)}">Back to XOS</a></p>`,
      );
      return;
    }
    const portal = /^\/portal\/(bps_fake[0-9]+)$/.exec(url.pathname);
    if (portal) {
      const found = portals.get(portal[1] ?? "");
      if (!found) return missing(response, "portal session");
      html(
        response,
        `<h1>Fake Stripe billing portal</h1>
<p>Customer: ${escape(found.customer)}</p>
<p><a href="${escape(found.returnUrl)}">Return to XOS</a></p>`,
      );
      return;
    }
    missing(response, "page");
  }

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", base);
    const handle = url.pathname.startsWith("/v1/") ? api : hosted;
    handle(request, response, url).catch((error: unknown) => {
      json(response, 500, { error: { type: "api_error", message: String(error) } });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    url: base,
    sessions,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
