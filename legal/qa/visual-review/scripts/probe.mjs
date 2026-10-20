// A59 visual review: one-off DOM probes behind specific findings (read-only).
//   node probe.mjs project-tabs | phone-topbar
import { ATLAS, demoPassword, launch } from "./lib.mjs";

const which = process.argv[2] ?? "project-tabs";
const browser = await launch();
const width = which.startsWith("phone") ? 375 : 1280;
const context = await browser.newContext({ viewport: { width, height: 800 } });
const page = await context.newPage();
await page.goto(`${ATLAS}/auth/sign-in?next=%2Fdemo-productions%2Fhome`);
await page.locator("#signin-email").fill("owner@example.com");
await page.locator("#signin-password").fill(demoPassword());
await page.getByRole("button", { name: "Sign in with password" }).click();
await page.waitForURL((u) => !u.pathname.startsWith("/auth"));
if (which === "project-tabs") {
  for (const w of [1280, 1440, 1920]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.goto(`${ATLAS}/demo-productions/p/NWS/budget`);
    await page.waitForLoadState("networkidle");
    const info = await page.evaluate(() => {
      const nav = [...document.querySelectorAll("nav")].find(
        (n) => /Overview/.test(n.textContent ?? "") && /Budget/.test(n.textContent ?? ""),
      );
      if (!nav) return null;
      const links = [...nav.querySelectorAll("a")];
      const box = nav.getBoundingClientRect();
      let el = nav;
      const scrollers = [];
      while (el) {
        const s = getComputedStyle(el);
        if (el.scrollWidth > el.clientWidth + 1)
          scrollers.push({
            tag: el.tagName,
            overflowX: s.overflowX,
            sw: el.scrollWidth,
            cw: el.clientWidth,
          });
        el = el.parentElement;
      }
      return {
        navRight: Math.round(box.right),
        hidden: links
          .filter((a) => a.getBoundingClientRect().left > window.innerWidth - 20)
          .map((a) => a.textContent?.trim()),
        partly: links
          .filter((a) => {
            const r = a.getBoundingClientRect();
            return r.right > window.innerWidth && r.left < window.innerWidth;
          })
          .map((a) => a.textContent?.trim()),
        scrollers,
        tabCount: links.length,
      };
    });
    console.log(w, JSON.stringify(info));
  }
}
if (which === "phone-menu") {
  await page.goto(`${ATLAS}/demo-productions/home`);
  await page.waitForLoadState("networkidle");
  const controls = await page.evaluate(() =>
    [...document.querySelectorAll("button, a")]
      .filter((b) => /menu/i.test(`${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`))
      .map((b) => ({
        tag: b.tagName,
        label: b.getAttribute("aria-label"),
        text: b.textContent?.trim().slice(0, 30),
        expanded: b.getAttribute("aria-expanded"),
        visible: b.getBoundingClientRect().height > 0,
      })),
  );
  console.log(JSON.stringify(controls));
  // The bottom bar's Menu clicks the first button[aria-controls][aria-expanded] in the document.
  const first = await page.evaluate(() => {
    const all = [...document.querySelectorAll("button[aria-controls][aria-expanded]")];
    return all.slice(0, 4).map((b) => ({
      label: b.getAttribute("aria-label") ?? b.textContent?.trim().slice(0, 30),
      controls: b.getAttribute("aria-controls"),
      visible: b.getBoundingClientRect().height > 0,
    }));
  });
  console.log("candidates", JSON.stringify(first));
  for (const [i, c] of controls.entries()) {
    if (!c.visible) continue;
    await page.goto(`${ATLAS}/demo-productions/home`);
    await page.waitForLoadState("networkidle");
    const target = page
      .locator("button, a")
      .filter({ hasText: c.text ? new RegExp(`^${c.text}$`) : undefined })
      .first();
    const el = c.label
      ? page.getByRole(c.tag === "A" ? "link" : "button", { name: c.label, exact: true }).first()
      : target;
    await el.click().catch((e) => console.log("click failed", String(e).slice(0, 80)));
    await page.waitForTimeout(2500);
    const dialogs = await page.locator("[role=dialog]:visible, nav:visible").count();
    await page.screenshot({ path: `${process.env.A59_PROBE_OUT ?? "."}/phone-menu-${i}.png` });
    console.log(i, c.label ?? c.text, "visible dialogs/navs:", dialogs);
  }
}
if (which === "phone-topbar") {
  await page.goto(`${ATLAS}/demo-productions/inbox`);
  await page.waitForLoadState("networkidle");
  const info = await page.evaluate(() => {
    const crumb = document.querySelector("nav[aria-label='Breadcrumb']");
    const r = crumb?.getBoundingClientRect();
    const header = crumb?.closest("header");
    return {
      crumb: r && { top: r.top, height: r.height, width: r.width },
      header: header && {
        height: header.getBoundingClientRect().height,
        overflow: getComputedStyle(header).overflow,
      },
    };
  });
  console.log(JSON.stringify(info));
}
await browser.close();
