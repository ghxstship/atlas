// A60: before and after screenshots for the Atlas shell and layout fixes of the A59 visual review.
// Signs in as the demo Owner and captures each finding's screen at the width the finding names, in
// the light theme. Run it once against a build of main (before) and once against the A60 branch
// (after); the label becomes part of every file name.
//   A59_ATLAS_URL=http://127.0.0.1:3060 node capture.mjs before [finding ...]
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ATLAS, demoPassword, launch, setTheme } from "../../scripts/lib.mjs";

const OUT = dirname(fileURLToPath(import.meta.url));
const ORG = "demo-productions";
const label = process.argv[2] ?? "after";
const wanted = process.argv.slice(3);
const password = demoPassword();

const DESKTOP = { viewport: { width: 1280, height: 800 } };
const PHONE = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true };

async function settle(page, ms = 500) {
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  await page.waitForTimeout(ms);
}

async function open(page, path) {
  await page.goto(`${ATLAS}/${ORG}${path}`);
  await page
    .getByRole("heading", { level: 1 })
    .first()
    .waitFor({ timeout: 15_000 })
    .catch(() => undefined);
  await settle(page);
  await setTheme(page, "light");
}

async function shot(page, name, { full = false } = {}) {
  const file = join(OUT, `${name}.${label}.jpg`);
  if (full) {
    // The shell scrolls an inner region; grow the viewport to its content height for the shot.
    const size = page.viewportSize();
    const extra = await page.evaluate(() => {
      const el = document.querySelector("[data-xos-bottom-bar-scroll], main > div:last-child");
      return el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
    });
    await page.setViewportSize({ width: size.width, height: Math.min(size.height + extra, 4000) });
    await page.waitForTimeout(300);
    await page.screenshot({ path: file, type: "jpeg", quality: 70 });
    await page.setViewportSize(size);
  } else {
    await page.screenshot({ path: file, type: "jpeg", quality: 70 });
  }
  console.log("wrote", file);
}

/** Each finding: the context options and the steps that reach its screen. */
const FLOWS = {
  "A59-001": [
    PHONE,
    async (page) => {
      await open(page, "/home");
      await page.getByRole("navigation", { name: "Main" }).last().getByText("Menu").click();
      await settle(page, 800);
      await shot(page, "A59-001-phone-menu");
    },
  ],
  "A59-002": [
    DESKTOP,
    async (page, context) => {
      await open(page, "/projects/all");
      await shot(page, "A59-002-1-tip-on-page");
      await page.getByRole("button", { name: "New project" }).first().click();
      await settle(page, 800);
      await page
        .getByRole("button", { name: "More fields" })
        .last()
        .click()
        .catch(() => undefined);
      await settle(page, 400);
      await shot(page, "A59-002-2-new-project-drawer");
      const phone = await context.browser().newContext(PHONE);
      const p = await phone.newPage();
      await signIn(p);
      await open(p, "/crew/shifts?create=1");
      await settle(p, 800);
      await shot(p, "A59-002-3-phone-new-shift");
      await phone.close();
    },
  ],
  "A59-003": [
    DESKTOP,
    async (page) => {
      await open(page, "/p/NWS/procurement");
      await shot(page, "A59-003-1-procurement-1280");
      await page.setViewportSize({ width: 1440, height: 800 });
      await open(page, "/p/NWS/overview");
      await shot(page, "A59-003-2-overview-1440");
      await page.setViewportSize({ width: 1280, height: 800 });
      const more = page.getByRole("button", { name: /More tabs/ });
      if (await more.count()) {
        await more.first().click();
        await settle(page, 600);
        await shot(page, "A59-003-3-more-menu-1280");
      }
    },
  ],
  "A59-004": [
    PHONE,
    async (page) => {
      await open(page, "/inbox");
      await shot(page, "A59-004-1-phone-inbox");
      await open(page, "/p/NWS/advancing");
      await shot(page, "A59-004-2-phone-advancing");
    },
  ],
  "A59-005": [
    PHONE,
    async (page) => {
      await open(page, "/settings/numbering");
      await shot(page, "A59-005-phone-numbering", { full: true });
    },
  ],
  "A59-008": [
    DESKTOP,
    async (page) => {
      await open(page, "/work/all-records?view=list");
      await shot(page, "A59-008-all-records-list");
    },
  ],
  "A59-012": [
    DESKTOP,
    async (page) => {
      await open(page, "/finance/expenses");
      await shot(page, "A59-012-1-expenses-1280");
      await open(page, "/finance/invoices");
      await shot(page, "A59-012-2-invoices-1280");
      await open(page, "/safety/dispatch-board");
      await shot(page, "A59-012-3-dispatch-board-1280");
    },
  ],
  "A59-013": [
    PHONE,
    async (page) => {
      await open(page, "/projects/all?view=table");
      await shot(page, "A59-013-1-phone-projects-table");
      await open(page, "/p/NWS/assets");
      await shot(page, "A59-013-2-phone-assets");
    },
  ],
  "A59-018": [
    DESKTOP,
    async (page) => {
      await open(page, "/settings/general");
      await shot(page, "A59-018-1-general", { full: true });
      const field = page.getByLabel("Legal name");
      if (await field.count()) {
        await field.fill("Demo Productions Holdings LLC");
        await settle(page, 300);
        await shot(page, "A59-018-2-general-dirty");
      }
    },
  ],
  "A59-023": [
    PHONE,
    async (page) => {
      await open(page, "/p/NWS/overview");
      const gate = page.getByRole("button", { name: /Pass gate/ }).first();
      await gate.scrollIntoViewIfNeeded().catch(() => undefined);
      await settle(page, 300);
      await shot(page, "A59-023-phone-gate-card");
    },
  ],
  "A59-029": [
    DESKTOP,
    async (page) => {
      await open(page, "/finance/invoices");
      const row = page.getByRole("row").nth(1);
      await row.hover();
      await settle(page, 300);
      await shot(page, "A59-029-1-row-hover");
      await row.dblclick();
      await settle(page, 1200);
      await shot(page, "A59-029-2-invoice-peek");
    },
  ],
};

async function signIn(page) {
  await page.goto(`${ATLAS}/auth/sign-in?next=${encodeURIComponent(`/${ORG}/home`)}`);
  await page.locator("#signin-email").fill("owner@example.com");
  await page.locator("#signin-password").fill(password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/auth/sign-in"), { timeout: 30_000 });
}

mkdirSync(OUT, { recursive: true });
const browser = await launch();
for (const [id, [options, run]] of Object.entries(FLOWS)) {
  if (wanted.length > 0 && !wanted.includes(id)) continue;
  const context = await browser.newContext({ ...options, colorScheme: "light" });
  const page = await context.newPage();
  try {
    await signIn(page);
    await run(page, context);
  } catch (error) {
    console.error(id, "failed:", String(error).split("\n")[0]);
  } finally {
    await context.close();
  }
}
await browser.close();
