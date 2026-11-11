import { createInterface } from "node:readline/promises";
import Stripe from "stripe";
import { loadPlanRegistry } from "@xos/schemas/plans";
import {
  CatalogDriftError,
  assertModeKey,
  syncStripeCatalog,
} from "../src/billing/stripe-setup.ts";

/**
 * Creates the pricing v4 catalogue of packages/schemas/plans.yaml in Stripe (ADR 0035) and the customer portal
 * configurations Atlas opens (ADR 0033 decision 59): in test mode by default, or in live mode when billing opens.
 *
 *   STRIPE_SECRET_KEY=sk_test_... pnpm --filter @xos/platform stripe:setup [--dry-run]
 *   STRIPE_SECRET_KEY=sk_live_... pnpm --filter @xos/platform stripe:setup --live [--dry-run]
 *
 * The key comes from the owner's environment only; the script never prints or stores it. Without --live it refuses
 * live keys; with --live it refuses test keys and, before writing, asks the owner to type LIVE. Safe to run again: it creates only what is missing, brings products and the portal
 * configuration up to date, and reports the rest as unchanged. Exits 2 when Stripe differs from
 * plans.yaml (see CatalogDriftError).
 */
const dryRun = process.argv.includes("--dry-run");
const live = process.argv.includes("--live");

try {
  const key = assertModeKey(process.env["STRIPE_SECRET_KEY"], live ? "live" : "test");
  if (live && !dryRun) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      "This creates the LIVE catalogue and portal in Stripe. Type LIVE to go on: ",
    );
    rl.close();
    if (answer.trim() !== "LIVE") {
      console.error("Stopped: nothing was written.");
      process.exit(1);
    }
  }
  const stripe = new Stripe(key, { maxNetworkRetries: 2 });
  const report = await syncStripeCatalog(stripe, loadPlanRegistry(), { dryRun });
  for (const item of report.items) {
    console.log(`${item.action.padEnd(13)} ${item.kind.padEnd(20)} ${item.key}`);
  }
  const created = report.items.filter((i) => i.action === "created").length;
  console.log(
    dryRun
      ? "Dry run: nothing was written."
      : `Done: ${String(created)} created, ${String(report.items.length - created)} already in place.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(error instanceof CatalogDriftError ? 2 : 1);
}
