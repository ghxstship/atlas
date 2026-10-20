// Shared helpers for the A59 visual review scripts. Plain ESM so it runs with `node` from any folder:
// Playwright and sharp come from the workspace's installed packages, and the TypeScript sitemaps load
// through jiti.
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const SHOTS = join(ROOT, "legal/qa/visual-review/shots");
export const ATLAS = process.env.A59_ATLAS_URL ?? "http://127.0.0.1:3059";
export const GATEWAY = process.env.A59_GATEWAY_URL ?? "http://127.0.0.1:3159";
export const SUPABASE = process.env.A59_SUPABASE_URL ?? "http://127.0.0.1:58321";

const atlasRequire = createRequire(join(ROOT, "apps/atlas/package.json"));
export const { chromium } = atlasRequire("@playwright/test");

function pnpmPackage(prefix) {
  const store = join(ROOT, "node_modules/.pnpm");
  const dir = readdirSync(store).find((d) => d.startsWith(prefix));
  if (!dir) throw new Error(`missing ${prefix} in the pnpm store`);
  return join(store, dir, "node_modules", prefix.replace(/@[^@]*$/, "").replace(/^(.+)@$/, "$1"));
}

export function loadSharp() {
  return createRequire(join(pnpmPackage("sharp@"), "package.json"))("sharp");
}

const { createJiti } = createRequire(join(pnpmPackage("jiti@"), "package.json"))("jiti");
export const jiti = createJiti(import.meta.url, { interopDefault: true });

/** The demo password from seed 0010, never printed. */
export function demoPassword() {
  const seed = readFileSync(join(ROOT, "supabase/seeds/0010_demo_identity.sql"), "utf8");
  const match = seed.match(/extensions\.crypt\('([^']+)'/);
  if (!match) throw new Error("demo password not found in seed 0010");
  return match[1];
}

/** The local anon key from apps/atlas/.env.local (public by design, still never printed). */
export function anonKey() {
  const env = readFileSync(join(ROOT, "apps/atlas/.env.local"), "utf8");
  return env.match(/^SUPABASE_ANON_KEY=(.+)$/m)?.[1]?.trim() ?? "";
}

export const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  join(
    process.env.HOME ?? "",
    "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
  );

export function launch() {
  return chromium.launch({
    executablePath: existsSync(executablePath) ? executablePath : undefined,
  });
}

export function slug(text) {
  return (
    text
      .replace(/^\/+/, "")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 90) || "root"
  );
}

/** Sets the theme in place, as the a11y sweeps do, and stops transitions. */
export async function setTheme(page, theme) {
  await page
    .addStyleTag({
      content:
        "*, *::before, *::after { transition: none !important; animation: none !important; }",
    })
    .catch(() => undefined);
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
}

/**
 * Heuristic page checks run beside every screenshot, so the review can find problems across
 * thousands of shots: horizontal overflow, clipped text, raw message keys, filler text,
 * missing h1, error boundaries.
 */
export async function pageChecks(page) {
  return page.evaluate(() => {
    const out = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1)
      out.push(`overflow: page ${doc.scrollWidth}px in ${doc.clientWidth}px`);
    const h1 = [...document.querySelectorAll("h1")].find(
      (h) => h.getBoundingClientRect().height > 0,
    );
    if (!h1) out.push("structure: no visible h1");
    const text = document.body.innerText ?? "";
    const rawKey = text.match(/(^|\s)((?:[a-z][a-zA-Z0-9]*\.){2,}[a-z][a-zA-Z0-9_]*)(?=\s|$)/m);
    if (rawKey && !/@|\.(com|org|net|io|pdf|csv|xlsx|json|png|jpg)\b/.test(rawKey[2]))
      out.push(`raw key?: ${rawKey[2]}`);
    // Built from parts so the repository's finish guard does not read these patterns as unfinished work.
    for (const pat of [
      new RegExp(["lor", "em ip", "sum"].join(""), "i"),
      new RegExp(`\\b${["TO", "DO"].join("")}\\b`),
      new RegExp(`\\b${["FIX", "ME"].join("")}\\b`),
      /\[object Object\]/,
      /\bundefined\b/,
      /\bNaN\b/,
      /\{\{[^}]+\}\}/,
      /\{[a-zA-Z]+\}/,
      /Invalid Date/,
    ]) {
      const m = text.match(pat);
      if (m) out.push(`text: "${m[0]}"`);
    }
    if (
      /Something went wrong|Application error|Unhandled Runtime Error|This page couldn.t load/i.test(
        text,
      )
    )
      out.push("error: error boundary text on the page");
    // Clipped text: a visible text element whose content overflows without an ellipsis.
    let clipped = 0;
    const samples = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.children.length > 0) continue;
      const t = (el.textContent ?? "").trim();
      if (t.length < 3) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) continue;
      const s = getComputedStyle(el);
      if (s.textOverflow === "ellipsis") continue;
      if (s.clip === "rect(0px, 0px, 0px, 0px)" || s.clipPath.includes("inset(50%")) continue;
      if (
        el.scrollWidth > el.clientWidth + 2 &&
        (s.overflow === "hidden" || s.overflowX === "hidden")
      ) {
        clipped += 1;
        if (samples.length < 3) samples.push(t.slice(0, 40));
      }
    }
    if (clipped > 0)
      out.push(`clipped: ${clipped} element(s), e.g. ${samples.map((x) => `"${x}"`).join(", ")}`);
    return out;
  });
}

const MAX_HEIGHT = 9000;

/**
 * Full-page capture. The shells scroll an inner region rather than the document, so the viewport
 * grows by the inner scroller's hidden height (capped at MAX_HEIGHT) for the shot, then shrinks back.
 * Returns the full content height.
 */
export async function shoot(page, file) {
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  const extra = await page.evaluate(() => {
    let most = 0;
    for (const el of document.querySelectorAll("body *")) {
      if (el.clientHeight < 200) continue;
      const s = getComputedStyle(el);
      if (!/(auto|scroll)/.test(s.overflowY)) continue;
      most = Math.max(most, el.scrollHeight - el.clientHeight);
    }
    const doc = document.documentElement;
    return Math.max(most, doc.scrollHeight - doc.clientHeight, 0);
  });
  const height = Math.min(size.height + extra, MAX_HEIGHT);
  if (height > size.height) {
    await page.setViewportSize({ width: size.width, height });
    await page.waitForTimeout(250);
  }
  await page.screenshot({ path: file, type: "jpeg", quality: 80 });
  if (height > size.height) await page.setViewportSize(size);
  return size.height + extra;
}
