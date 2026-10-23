// Stripe webhook endpoint: verifies the Stripe signature, stores each event once and applies subscription
// changes. Needs STRIPE_SECRET_KEY (for the mode) and STRIPE_WEBHOOK_SECRET from the owner's Stripe account.
import {
  StripeSignatureError,
  billingStore,
  handleStripeWebhook,
  isTestKey,
  planRegistry,
} from "../_vendor/stripe-webhook.js";
import { env, json, serve, serviceDb } from "../_shared/runtime.ts";

serve(async (request) => {
  if (request.method !== "POST")
    return json(405, {
      type: "/problems/method-not-allowed",
      title: "Method not allowed",
      status: 405,
    });
  try {
    const outcome = await handleStripeWebhook({
      rawBody: await request.text(),
      signature: request.headers.get("Stripe-Signature"),
      webhookSecret: env("STRIPE_WEBHOOK_SECRET"),
      livemode: !isTestKey(env("STRIPE_SECRET_KEY")),
      registry: planRegistry,
      store: billingStore(serviceDb()),
    });
    return json(outcome.outcome === "failed" ? 500 : 200, outcome);
  } catch (error) {
    if (error instanceof StripeSignatureError) {
      return json(400, {
        type: "/problems/invalid-signature",
        title: "Invalid signature",
        status: 400,
        detail: error.message,
      });
    }
    throw error;
  }
});
