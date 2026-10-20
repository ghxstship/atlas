// A59 visual review: signs in as each demo person and captures every sitemap route they can see,
// full page, at desktop 1280 and phone 375, in light and dark, with heuristic page checks beside
// each shot. Results land in shots/<app>/<who>/ and shots/<app>-<who>.json.
//
//   node capture-web.mjs atlas [who,...]     who = owner, producer, finance, field, viewer, partner
//   node capture-web.mjs gateway [who,...]   who = crew, vendor, artist, client, sponsor, staff
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ATLAS,
  GATEWAY,
  ROOT,
  SHOTS,
  demoPassword,
  jiti,
  launch,
  pageChecks,
  setTheme,
  shoot,
  slug,
} from "./lib.mjs";
import { atlasRoles, atlasRoutes, gatewayPeople, gatewayRoutes } from "./plan.mjs";

const [app = "atlas", filter = ""] = process.argv.slice(2);
const wanted = filter.split(",").filter(Boolean);
const ia = await jiti.import(join(ROOT, "packages/ia/src/index.ts"));
const sm = await jiti.import(join(ROOT, `apps/${app}/ia/sitemap.generated.ts`));
const base = app === "atlas" ? ATLAS : GATEWAY;
const password = demoPassword();

const VIEWPORTS = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, isMobile: false },
  { name: "phone", viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
];
const THEMES = ["light", "dark"];

async function signIn(browser, who) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const next = app === "atlas" ? `/${who.org}/home` : "/home";
  await page.goto(`${base}/auth/sign-in?next=${encodeURIComponent(next)}`);
  await page.locator("#signin-email").fill(who.email);
  await page.locator("#signin-password").fill(password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/auth/sign-in"), { timeout: 30_000 });
  const state = await context.storageState();
  const landed = page.url();
  await context.close();
  return { state, landed };
}

async function settle(page) {
  await page
    .getByRole("heading", { level: 1 })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
}

/** Engagement tab links and list detail links the person can reach from Gateway's own pages. */
async function discoverGateway(page) {
  const found = new Map();
  const collect = async (path) => {
    await page.goto(`${base}${path}`);
    await settle(page);
    const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href") ?? ""));
    return hrefs.filter((h) => h.startsWith("/"));
  };
  const work = [...(await collect("/work")), ...(await collect("/work/engagements"))];
  const engagements = [
    ...new Set(work.map((h) => h.match(/^\/work\/engagements\/([^/?#]+)/)?.[1]).filter(Boolean)),
  ].slice(0, 3);
  for (const key of engagements) {
    const tabs = await collect(`/work/engagements/${key}`);
    for (const h of tabs) {
      const m = h.match(/^\/work\/engagements\/[^/?#]+\/[a-z-]+$/);
      if (m) found.set(h, `engagement.${h.split("/").pop()}`);
    }
    found.set(`/work/engagements/${key}`, "engagement");
  }
  for (const list of ["/explore", "/messages"]) {
    const hrefs = await collect(list);
    const detail = hrefs.find(
      (h) => /^\/(explore|opportunities|messages)\/[^/]+$/.test(h) && h !== list,
    );
    if (detail) found.set(detail, `${list.slice(1)}.detail`);
  }
  return [...found].map(([path, id]) => ({ id, path }));
}

async function run() {
  const browser = await launch();
  const people =
    app === "atlas"
      ? atlasRoles.map((r) => ({ ...r, who: r.label ?? r.role }))
      : gatewayPeople.map((p) => ({ ...p, who: p.person }));
  for (const who of people.filter((p) => wanted.length === 0 || wanted.includes(p.who))) {
    const started = Date.now();
    const dir = join(SHOTS, app, who.who);
    mkdirSync(dir, { recursive: true });
    const results = [];
    let state;
    let landed;
    try {
      ({ state, landed } = await signIn(browser, who));
    } catch (error) {
      results.push({ who: who.who, error: `sign-in failed: ${String(error).slice(0, 200)}` });
      writeFileSync(join(SHOTS, `${app}-${who.who}.json`), JSON.stringify(results, null, 1));
      console.log(`${app} ${who.who}: sign-in failed`);
      continue;
    }
    let routes =
      app === "atlas" ? atlasRoutes(ia, sm.sitemap, who) : gatewayRoutes(ia, sm.sitemap, who);
    if (app === "gateway") {
      const ctx = await browser.newContext({
        storageState: state,
        viewport: { width: 1280, height: 800 },
      });
      const page = await ctx.newPage();
      const extra = await discoverGateway(page).catch(() => []);
      await ctx.close();
      const seen = new Set(routes.map((r) => r.path));
      routes = [...routes, ...extra.filter((r) => !seen.has(r.path))];
    }
    if (process.env.A59_LIMIT) routes = routes.slice(0, Number(process.env.A59_LIMIT));
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({
        storageState: state,
        viewport: vp.viewport,
        isMobile: vp.isMobile,
        hasTouch: vp.hasTouch ?? false,
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      let consoleErrors = [];
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
      });
      page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));
      for (const [i, route] of routes.entries()) {
        consoleErrors = [];
        const name = `${String(i).padStart(3, "0")}-${slug(route.path)}`;
        const record = { who: who.who, id: route.id, path: route.path, viewport: vp.name };
        try {
          const response = await page.goto(`${base}${route.path}`, { timeout: 30_000 });
          record.status = response?.status() ?? 0;
          await settle(page);
          record.url = page.url().replace(base, "");
          record.h1 = (
            await page
              .locator("h1")
              .first()
              .textContent({ timeout: 1000 })
              .catch(() => "")
          )?.trim();
          // Before the theme switch: the injected no-transition style trips the CSP report.
          record.console = [...new Set(consoleErrors)].slice(0, 5);
          record.shots = {};
          for (const theme of THEMES) {
            await page.emulateMedia({ colorScheme: theme });
            await setTheme(page, theme);
            await page.waitForTimeout(350);
            if (theme === "light") record.checks = await pageChecks(page);
            const file = join(dir, `${name}.${vp.name}.${theme}.jpg`);
            record.height = await shoot(page, file);
            record.shots[theme] = file.replace(`${SHOTS}/`, "");
          }
        } catch (error) {
          record.error = String(error).split("\n")[0].slice(0, 200);
        }
        record.console ??= [...new Set(consoleErrors)].slice(0, 5);
        results.push(record);
      }
      await context.close();
    }
    writeFileSync(
      join(SHOTS, `${app}-${who.who}.json`),
      JSON.stringify({ who: who.who, email: who.email, landed, results }, null, 1),
    );
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(`${app} ${who.who}: ${routes.length} routes, ${results.length} visits, ${secs}s`);
  }
  await browser.close();
}

await run();
