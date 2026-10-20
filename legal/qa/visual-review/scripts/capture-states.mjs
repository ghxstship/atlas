// A59 visual review: key interface states and the settings workflows the journey specs do not walk.
// Each flow signs in, runs its steps in order and captures the viewport after every step in light
// and dark (desktop 1280, and phone 375 where the flow says so). Results: shots/states/<flow>/ and
// shots/states.json.
//   node capture-states.mjs [flow ...]
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  ATLAS,
  GATEWAY,
  ROOT,
  SHOTS,
  demoPassword,
  launch,
  pageChecks,
  setTheme,
  slug,
} from "./lib.mjs";

const ORG = "demo-productions";
const password = demoPassword();
const wanted = process.argv.slice(2);

async function signIn(page, base, email, next) {
  await page.goto(`${base}/auth/sign-in?next=${encodeURIComponent(next)}`);
  await page.locator("#signin-email").fill(email);
  await page.locator("#signin-password").fill(password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/auth/sign-in"), { timeout: 30_000 });
}

async function settle(page, ms = 400) {
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
  await page.waitForTimeout(ms);
}

const go =
  (path, base = ATLAS) =>
  async (page) => {
    await page.goto(`${base}${path}`);
    await page
      .getByRole("heading", { level: 1 })
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(() => undefined);
    await settle(page);
  };
const click =
  (name, role = "button") =>
  async (page) => {
    await page.getByRole(role, { name }).first().click({ timeout: 10_000 });
    await settle(page);
  };
const press = (key) => async (page) => {
  await page.keyboard.press(key);
  await settle(page, 600);
};
const type = (text) => async (page) => {
  await page.keyboard.type(text, { delay: 20 });
  await settle(page, 800);
};

/** Flows: who signs in, on which app, and the steps. `phone: true` repeats the flow at 375. */
const FLOWS = [
  {
    name: "atlas-command-menu",
    email: "owner@example.com",
    phone: true,
    steps: [
      ["home", go(`/${ORG}/home`)],
      ["open-command-menu", press("ControlOrMeta+k")],
      ["type-incident", type("incident")],
      [
        "type-action",
        async (page) => {
          await page.keyboard.press("ControlOrMeta+a");
          await page.keyboard.type("approve", { delay: 20 });
          await settle(page, 800);
        },
      ],
      [
        "type-no-match",
        async (page) => {
          await page.keyboard.press("ControlOrMeta+a");
          await page.keyboard.type("zzqx nothing", { delay: 20 });
          await settle(page, 800);
        },
      ],
    ],
  },
  {
    name: "atlas-shortcuts-focus",
    email: "owner@example.com",
    steps: [
      ["home", go(`/${ORG}/projects/all`)],
      ["shortcut-sheet", press("Shift+?")],
      ["close", press("Escape")],
      ["focus-mode", press("ControlOrMeta+.")],
      [
        "account-menu",
        async (page) => {
          await page.keyboard.press("ControlOrMeta+.");
          await click("Account")(page);
        },
      ],
    ],
  },
  {
    name: "atlas-peek",
    email: "producer@example.com",
    phone: true,
    steps: [
      ["peek-record", go(`/${ORG}/home?peek=NWS-12`)],
      ["peek-missing", go(`/${ORG}/home?peek=NWS-99999`)],
      ["record-full-page", go(`/${ORG}/r/NWS-12`)],
    ],
  },
  {
    name: "atlas-aurora",
    email: "owner@example.com",
    phone: true,
    steps: [
      ["home", go(`/${ORG}/home`)],
      [
        "open-aurora",
        async (page) => {
          await page
            .locator("html[data-aurora-ready]")
            .waitFor({ state: "attached", timeout: 15_000 })
            .catch(() => undefined);
          await page.keyboard.press("ControlOrMeta+j");
          await page.getByRole("dialog", { name: "Aurora" }).waitFor({ timeout: 10_000 });
          await settle(page);
        },
      ],
      [
        "ask",
        async (page) => {
          const input = page
            .getByRole("dialog", { name: "Aurora" })
            .getByLabel("Ask about your org's records");
          await input.fill("Which permits are blocked in US-FL-MIAMI-DADE?");
          await input.press("Enter");
          await settle(page, 4000);
        },
      ],
    ],
  },
  {
    name: "atlas-create-project",
    email: "owner@example.com",
    phone: true,
    steps: [
      ["projects", go(`/${ORG}/projects/all`)],
      ["new-project-dialog", click("New project")],
      [
        "more-fields",
        async (page) => {
          await page.getByRole("dialog").getByRole("button", { name: "More fields" }).click();
          await settle(page);
        },
      ],
      [
        "submit-empty",
        async (page) => {
          await page.getByRole("dialog").getByRole("button", { name: "Create project" }).click();
          await settle(page);
        },
      ],
    ],
  },
  {
    name: "atlas-create-forms",
    email: "producer@example.com",
    phone: true,
    steps: [
      ["incidents-create", go(`/${ORG}/safety/incidents?create=1`)],
      ["expenses-create", go(`/${ORG}/finance/expenses?create=1`)],
      ["purchase-orders-create", go(`/${ORG}/procurement/purchase-orders?create=1`)],
      ["offers-create", go(`/${ORG}/people/offers?create=1`)],
      ["shifts-create", go(`/${ORG}/crew/shifts?create=1`)],
    ],
  },
  {
    name: "atlas-viewer-refusals",
    email: "viewer@example.com",
    steps: [
      ["projects-create", go(`/${ORG}/projects/all?create=1`)],
      ["settings", go(`/${ORG}/settings`)],
      ["finance", go(`/${ORG}/finance`)],
      ["not-found", go(`/${ORG}/finance/not-a-page`)],
    ],
  },
  {
    name: "atlas-phone-shell",
    email: "field@example.com",
    phoneOnly: true,
    steps: [
      ["home", go(`/${ORG}/home`)],
      ["menu-drawer", click("Menu")],
      ["my-work", go(`/${ORG}/my-work`)],
    ],
  },
  {
    name: "atlas-handoff",
    email: "field@example.com",
    phone: true,
    steps: [
      ["record", go(`/${ORG}/r/NWS-14`)],
      ["continue-on-phone", click("Continue on phone")],
    ],
  },
  {
    name: "atlas-settings-billing",
    email: "owner@example.com",
    phone: true,
    steps: [
      ["home-plan-card", go(`/${ORG}/home`)],
      ["compare-plans", click("Compare plans", "link")],
      ["usage", go(`/${ORG}/settings/usage`)],
    ],
  },
  {
    name: "atlas-settings-security",
    email: "owner@example.com",
    phone: true,
    steps: [
      ["security", go(`/${ORG}/settings/security`)],
      [
        "add-network-empty-submit",
        async (page) => {
          const form = page.getByRole("form", { name: "Add a network" });
          await form.getByRole("button", { name: "Add network" }).click();
          await settle(page);
        },
      ],
      [
        "add-network-invalid",
        async (page) => {
          const form = page.getByRole("form", { name: "Add a network" });
          await form.getByLabel("Address or network").fill("not an address");
          await form.getByLabel("Label").fill("Bad");
          await form.getByRole("button", { name: "Add network" }).click();
          await settle(page);
        },
      ],
      [
        "add-network-loopback",
        async (page) => {
          const form = page.getByRole("form", { name: "Add a network" });
          await form.getByLabel("Address or network").fill("127.0.0.0/8");
          await form.getByLabel("Label").fill("Local review network");
          await form.getByRole("button", { name: "Add network" }).click();
          await settle(page, 1200);
        },
      ],
      [
        "break-glass-short-reason",
        async (page) => {
          const form = page.getByRole("form", { name: "Take emergency access" });
          await form.getByLabel("Why do you need emergency access?").fill("Too short");
          await form.getByRole("button", { name: "Take emergency access" }).click();
          await settle(page, 1000);
        },
      ],
      [
        "break-glass-reason",
        async (page) => {
          const form = page.getByRole("form", { name: "Take emergency access" });
          await form
            .getByLabel("Why do you need emergency access?")
            .fill("Visual review: checking the emergency access refusal without a second factor.");
          await form.getByRole("button", { name: "Take emergency access" }).click();
          await settle(page, 1500);
        },
      ],
      [
        "remove-network",
        async (page) => {
          await page
            .getByRole("button", { name: "Remove the network Local review network" })
            .click();
          await settle(page, 1200);
        },
      ],
    ],
  },
  {
    name: "atlas-settings-access-review",
    email: "owner@example.com",
    phone: true,
    steps: [
      ["access-reviews", go(`/${ORG}/settings/access-reviews`)],
      [
        "open-review",
        async (page) => {
          const form = page.getByRole("form", { name: "Open an access review" });
          await form.getByRole("button", { name: "Open review" }).click();
          await settle(page, 1500);
        },
      ],
      [
        "confirm-one",
        async (page) => {
          await page
            .getByRole("button", { name: /^Confirm the / })
            .first()
            .click();
          await settle(page, 1200);
        },
      ],
      [
        "remove-one",
        async (page) => {
          await page
            .getByRole("button", { name: /^Remove the .*role of Demo Viewer/ })
            .first()
            .click();
          await settle(page, 1200);
        },
      ],
      [
        "cancel-review",
        async (page) => {
          await page.getByRole("button", { name: "Cancel review" }).click();
          await settle(page, 1200);
        },
      ],
    ],
  },
  {
    name: "atlas-documents-pdf",
    email: "owner@example.com",
    steps: [
      ["finance-invoices", go(`/${ORG}/finance/invoices`)],
      [
        "invoice-peek",
        async (page) => {
          // Rows open the peek on click (or Enter); the first payable is the seeded CFL-20481.
          await page
            .getByRole("main")
            .getByText(/^CFL-|^INV-/)
            .first()
            .click();
          await page.keyboard.press("Enter");
          await settle(page, 800);
        },
      ],
      [
        "download-pdf",
        async (page) => {
          const [download] = await Promise.all([
            page.waitForEvent("download", { timeout: 20_000 }),
            page.getByRole("link", { name: "Download PDF" }).first().click(),
          ]);
          const file = join(SHOTS, "states", "atlas-documents-pdf", "invoice.pdf");
          await download.saveAs(file);
          await settle(page, 500);
        },
      ],
      ["documents", go(`/${ORG}/knowledge/documents`)],
    ],
  },
  {
    name: "gateway-crew-shell",
    email: "crew@example.com",
    base: GATEWAY,
    phone: true,
    steps: [
      ["home", go("/home", GATEWAY)],
      [
        "avatar-menu",
        async (page) => {
          await page
            .getByRole("button", { name: /account|menu|Demo Crew/i })
            .first()
            .click();
          await settle(page);
        },
      ],
      [
        "command-menu",
        async (page) => {
          await page.keyboard.press("Escape");
          await page.keyboard.press("ControlOrMeta+k");
          await settle(page, 800);
        },
      ],
      ["not-found", go("/work/engagements/NOPE-1/overview", GATEWAY)],
    ],
  },
  {
    name: "gateway-anonymous",
    base: GATEWAY,
    phone: true,
    steps: [
      ["sign-in", go("/auth/sign-in", GATEWAY)],
      [
        "sign-in-wrong-password",
        async (page) => {
          await page.locator("#signin-email").fill("crew@example.com");
          await page.locator("#signin-password").fill("wrong-password-for-review");
          await page.getByRole("button", { name: "Sign in with password" }).click();
          await settle(page, 1500);
        },
      ],
      ["sign-up", go("/auth/sign-up", GATEWAY)],
      ["public-profile", go("/u/demo-crew", GATEWAY)],
      ["public-company", go("/c/demo-productions", GATEWAY)],
      ["unknown-profile", go("/u/nobody-here", GATEWAY)],
    ],
  },
  {
    name: "atlas-anonymous",
    phone: true,
    steps: [
      ["sign-in", go("/auth/sign-in")],
      [
        "magic-link",
        async (page) => {
          await page
            .locator("#signin-email")
            .fill("owner@example.com")
            .catch(() => undefined);
          await settle(page);
        },
      ],
      ["sign-up", go("/auth/sign-up")],
      ["network-restricted", go("/auth/network-restricted")],
      ["invite-bad-token", go("/auth/invite/not-a-real-token")],
      ["legal", go("/legal/acceptable-use-policy")],
    ],
  },
];

async function capture(page, dir, name, results, flow, vp) {
  const record = {
    flow: flow.name,
    step: name,
    viewport: vp,
    url: page.url().replace(/^https?:\/\/[^/]+/, ""),
  };
  record.checks = await pageChecks(page).catch(() => []);
  record.shots = {};
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    await setTheme(page, theme);
    await page.waitForTimeout(300);
    const file = join(dir, `${name}.${vp}.${theme}.jpg`);
    await page.screenshot({ path: file, type: "jpeg", quality: 80 });
    record.shots[theme] = file.replace(`${SHOTS}/`, "");
  }
  results.push(record);
}

const browser = await launch();
const out = join(SHOTS, "states.json");
const results = existsSync(out)
  ? JSON.parse(readFileSync(out, "utf8")).filter((r) => wanted.length && !wanted.includes(r.flow))
  : [];
for (const flow of FLOWS.filter((f) => wanted.length === 0 || wanted.includes(f.name))) {
  const dir = join(SHOTS, "states", flow.name);
  mkdirSync(dir, { recursive: true });
  const viewports = flow.phoneOnly ? ["phone"] : flow.phone ? ["desktop", "phone"] : ["desktop"];
  for (const vp of viewports) {
    const context = await browser.newContext({
      viewport: vp === "phone" ? { width: 375, height: 812 } : { width: 1280, height: 800 },
      isMobile: vp === "phone",
      hasTouch: vp === "phone",
    });
    const page = await context.newPage();
    try {
      if (flow.email) {
        const base = flow.base ?? ATLAS;
        await signIn(page, base, flow.email, base === ATLAS ? `/${ORG}/home` : "/home");
      }
      for (const [i, [name, run]] of flow.steps.entries()) {
        const step = `${String(i + 1).padStart(2, "0")}-${slug(name)}`;
        try {
          await run(page);
          await setTheme(page, "light");
          await capture(page, dir, step, results, flow, vp);
        } catch (error) {
          results.push({
            flow: flow.name,
            step,
            viewport: vp,
            error: String(error).split("\n")[0].slice(0, 240),
          });
          await capture(page, dir, step, results, flow, vp).catch(() => undefined);
        }
      }
    } catch (error) {
      results.push({
        flow: flow.name,
        viewport: vp,
        error: `flow: ${String(error).split("\n")[0].slice(0, 240)}`,
      });
    }
    await context.close();
  }
  console.log(`${flow.name}: done`);
}
await browser.close();
writeFileSync(out, JSON.stringify(results, null, 1));
console.log(`states: ${results.length} records, ${results.filter((r) => r.error).length} errors`);
void ROOT;
