import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkRouteBudgets, kb, keyPages, transferBytes, type BudgetApp } from "./bundle-budget.ts";
import { findForbiddenClientCode } from "./client-chunk-audit.ts";
import { sessionCookies } from "./lighthouse.ts";
import { signedInRoutes } from "./lighthouse-routes.ts";
import {
  scriptRequests,
  servedRow,
  servedTargets,
  type NetworkEvent,
  type ServedRow,
} from "./served-budget.ts";
import { signIn } from "./session.ts";

/**
 * Route JavaScript budget check for CI, in transfer bytes as Lighthouse counts them.
 *
 * `budget:js` runs after `next build` of Atlas, Gateway, docs and the console, from the build
 * manifests (bundle-budget.ts): the scripts of each key page and each signed-in route as
 * `next start` sends them, against 200 KB or the route's recorded ceiling. With --chunks it also
 * lists each printed page's chunks by size, for finding what to split.
 *
 * `budget:js -- --served [atlas|gateway|docs]` loads each key page from the running servers in
 * Chromium instead, signed in as the page's demo person, and counts every script fetched until
 * the network goes quiet, the chunks a page loads after hydration included (served-budget.ts). It
 * needs the stack and the servers: SUPABASE_URL, SUPABASE_ANON_KEY, and ATLAS_URL, GATEWAY_URL or
 * DOCS_URL when they are not on the Lighthouse ports.
 *
 * Either exits 1 when a page passes 200 KB, or the ceiling recorded for it.
 */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const ceilings = JSON.parse(
  readFileSync(new URL("../bundle-ceilings.json", import.meta.url), "utf8"),
) as { pages: Record<string, number> };

/** Settles after the load event: no request for this long, as Lighthouse's quiet window is. */
const QUIET_MS = 1_000;

async function measureServed(): Promise<ServedRow[]> {
  const { chromium } = await import("@playwright/test");
  const named = process.argv
    .slice(2)
    .filter((a): a is "atlas" | "gateway" | "docs" => ["atlas", "gateway", "docs"].includes(a));
  const targets = servedTargets(named.length > 0 ? named : ["atlas", "gateway", "docs"], {
    atlas: process.env["ATLAS_URL"],
    gateway: process.env["GATEWAY_URL"],
    docs: process.env["DOCS_URL"],
  });
  const browser = await chromium.launch();
  const rows: ServedRow[] = [];
  try {
    for (const target of targets) {
      const cookies = target.email ? sessionCookies("xos-auth", await signIn(target.email)) : [];
      const host = new URL(target.baseUrl).hostname;
      for (const path of target.paths) {
        // A fresh context per page: a cold cache, as Lighthouse loads each page. The viewport is
        // Lighthouse's desktop preset, so the same links sit on screen.
        const context = await browser.newContext({ viewport: { width: 1350, height: 940 } });
        await context.addCookies(
          cookies.map((c) => ({ ...c, domain: host, path: "/", httpOnly: true, sameSite: "Lax" })),
        );
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        const events: NetworkEvent[] = [];
        let last = Date.now();
        cdp.on("Network.requestWillBeSent", (e) => {
          last = Date.now();
          events.push({ kind: "request", id: e.requestId, type: e.type ?? "", url: e.request.url });
        });
        cdp.on("Network.loadingFinished", (e) => {
          last = Date.now();
          events.push({
            kind: "finished",
            id: e.requestId,
            encodedDataLength: e.encodedDataLength,
          });
        });
        await cdp.send("Network.enable");
        await page.goto(`${target.baseUrl}${path}`, { waitUntil: "load" });
        // Wait for a quiet second, as long as ten seconds: a live page keeps a socket open, which
        // sends no further script.
        const deadline = Date.now() + 10_000;
        while (Date.now() - last < QUIET_MS && Date.now() < deadline) {
          await page.waitForTimeout(100);
        }
        rows.push(servedRow(target.app, path, scriptRequests(events), ceilings.pages));
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return rows;
}

/**
 * Every page the static check reads: the key pages, and in Atlas and Gateway every signed-in route
 * the nightly Lighthouse run visits (lighthouse-routes.ts), each against 200 KB or its ceiling.
 */
function everyPage(): Record<BudgetApp, readonly string[]> {
  const pages = keyPages();
  const routes = (app: "atlas" | "gateway") => [
    ...new Set([...pages[app], ...signedInRoutes(app).flatMap((s) => s.paths)]),
  ];
  return { ...pages, atlas: routes("atlas"), gateway: routes("gateway") };
}

const served = process.argv.includes("--served");
const rows = served
  ? await measureServed()
  : checkRouteBudgets(repoRoot, ceilings.pages, everyPage());
const key = new Set(Object.entries(keyPages()).flatMap(([app, ps]) => ps.map((p) => `${app}${p}`)));
if (rows.length === 0) {
  console.error("No production build found under apps/<app>/.next. Run next build first.");
  process.exit(1);
}
for (const row of rows) {
  // Key pages always print; another route prints when it fails.
  if (row.pass && !key.has(`${row.app}${row.path}`)) continue;
  const verdict = row.pass ? "ok  " : "OVER";
  console.log(
    `${verdict} ${row.app.padEnd(8)}${row.path.padEnd(36)}${kb(row.transferBytes).padStart(8)} of ${kb(row.budgetBytes)}`,
  );
  if (!process.argv.includes("--chunks")) continue;
  const sized =
    "scripts" in row
      ? row.scripts.map((s) => ({ f: new URL(s.url).pathname, bytes: s.transferBytes, head: "" }))
      : row.files.map((f) => {
          const body = readFileSync(`${repoRoot}apps/${row.app}/.next/${f}`);
          return { f, bytes: transferBytes(body), head: body.toString("utf8", 0, 90) };
        });
  for (const c of sized.sort((a, b) => b.bytes - a.bytes).slice(0, 8)) {
    console.log(`       ${kb(c.bytes).padStart(7)} ${c.f} ${c.head.replace(/\s+/g, " ")}`);
  }
}
const over = rows.filter((r) => !r.pass);
if (over.length > 0) {
  console.error(`${over.length} page(s) over the route JavaScript budget.`);
  process.exit(1);
}
console.log(`All ${rows.length} pages within the route JavaScript budget or their ceilings.`);

if (!served) {
  // The Sentry browser SDK must never ship to a browser (ADR 0025): errors go through the reporter.
  const audit = findForbiddenClientCode(repoRoot);
  for (const hit of audit.hits) console.error(`FORBIDDEN ${hit.app} ${hit.file}: ${hit.name}`);
  if (audit.hits.length > 0) {
    console.error(`${audit.hits.length} client chunk(s) carry code that must stay on the server.`);
    process.exit(1);
  }
  console.log(`No Sentry SDK in the client chunks of ${audit.scanned.join(", ")}.`);
}
