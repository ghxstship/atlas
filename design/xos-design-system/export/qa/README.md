# Responsive and anatomy audit

The audit that validated this design system, packaged for CI. It renders every preview (or, in the repo, every Storybook story) at each viewport and engine, then checks the page in the browser.

| File | Role |
| --- | --- |
| `raudit.js` | In-page audit, engine-neutral. Returns page overflow, elements escaping the viewport, clipped text, ellipsis without the full text available, overlapping text, overlapping targets, target size (24 px fine pointer with the WCAG 2.5.8 spacing exception; 44 px coarse pointer, counting `::before` hit areas; `min: 48` for Compass surfaces), labels squeezed below 48 px, targets measured only where their scroll container shows them, distorted images, text under 11 px, and token conformance (font size, weight, padding, gap, radius, stroke width, text and background color against the theme's resolved tokens). |
| `rsite.js` | Serves each preview with the real fonts (Inter variable, JetBrains Mono), the theme variables from `tokens.json` and the component bundle. |
| `rchromium.js` | Chromium (Blink: Chrome, Edge, Samsung Internet) through Playwright at 12 viewports from 320 to 1920 px, with touch and coarse-pointer emulation on phones and tablets. Token conformance runs at 1440 px in all three themes. |
| `rwebkit.js` | WebKit (the Safari engine) through WebKitWebDriver at 320, 390, 768, 1024 and 1440 px. Narrow widths render in an exact-width iframe. |

**Viewports:** 320 (WCAG 1.4.10 reflow), 375, 390 and 430 (Compass phones), 412 (Android), 640 (`bp-sm`), 768 (`bp-md`, tablet), 1024 (`bp-lg`, Atlas tablet), 1280 (`bp-xl`, Atlas laptop), 1440 (Atlas desktop), 1536 (`bp-2xl`), 1920 (`bp-3xl`).

**In the repo:** run the same `raudit.js` from the Playwright suite over Storybook stories in the `chromium`, `firefox` and `webkit` projects (`@playwright/test` installs all three in CI). Fail the build on any finding except the accepted exceptions recorded as decision D18 in the README.

**Screens:** the Section 11.5 screens run through the same `raudit.js` at each board's own size (1440, 1280 and 1024 px for Atlas; 390 by 844, 430 by 932 and 834 by 1194 for Compass; 1440 and 390 px for Gateway), in Chromium and WebKit, with token conformance and axe-core. Use the screens as Playwright page fixtures once the app shells exist.
