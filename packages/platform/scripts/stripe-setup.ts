import Stripe from "stripe";
import { loadPlanRegistry } from "@xos/schemas/plans";
import {
  CatalogDriftError,
  assertTestModeKey,
  syncStripeCatalog,
} from "../src/billing/stripe-setup.ts";

/**
 * Creates the pricing v4 catalogue of packages/schemas/plans.yaml in Stripe test mode (ADR 0034).
 *
 *   STRIPE_SECRET_KEY=sk_test_... pnpm --filter @xos/platform stripe:setup [--dry-run]
 *
 * Refuses live mode keys. Safe to run again: it creates only what is missing and reports the rest
 * as unchanged. Exits 2 when Stripe differs from plans.yaml (see CatalogDriftError).
 */
const dryRun = process.argv.includes("--dry-run");

try {
  const key = assertTestModeKey(process.env["STRIPE_SECRET_KEY"]);
  const stripe = new Stripe(key, { maxNetworkRetries: 2 });
  const report = await syncStripeCatalog(stripe, loadPlanRegistry(), { dryRun });
  for (const item of report.items) {
    console.log(`${item.action.padEnd(13)} ${item.kind.padEnd(15)} ${item.key}`);
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
