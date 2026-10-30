import { deflateSync } from "node:zlib";
import { expect, settle, test, type Page } from "./engine-test";
import { passAttachmentScans } from "./attachment-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * B1 places depth journeys on the demo tenant (RRR-225, ADR 0140): a site plan's stored drawing, its scale, a route and
 * an area drawn by keyboard and measured, the lock, a pin's comment with a mention and Resolve, the PDF export; two
 * levels ordering the plans; the venue's specs added as capabilities and reconciled; and a sign placed at a pin, marked
 * printed and placed, with its build sheet. Uploads are marked Clean by the scan worker's stand-in (record_attachment_scan).
 * Every touched page is checked with axe in both themes.
 */

test.use({ reducedMotion: "reduce" });

const ORG = "demo-productions";
const DEMO_PASSWORD = `xos-demo-${"2026"}`;
const slow = expect.configure({ timeout: 30_000 });

async function signIn(page: Page, email = "owner@example.com") {
  await page.goto(`/auth/sign-in?next=${encodeURIComponent(`/${ORG}/home`)}`);
  await page.locator("#signin-email").fill(email);
  await page.locator("#signin-password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL(`**/${ORG}/home`);
}

async function inBothThemes(page: Page) {
  await expectAccessible(page);
  for (const theme of ["light", "dark"] as const) {
    await page.context().addCookies([{ name: "xos-theme", value: theme, url: page.url() }]);
    await page.reload();
    await settle(page);
    await expectAccessible(page);
  }
}

/** A 2000 by 1000 PNG drawing: a plain light frame, so the overlay is what is measured. */
function drawing(): Buffer {
  const width = 2000;
  const height = 1000;
  const row = Buffer.alloc(1 + width * 3, 0xee);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Types the points of the active tool into its point list, the keyboard path of every tool. */
async function typePoints(page: Page, points: readonly (readonly [number, number])[]) {
  const tools = page.getByRole("region", { name: "Drawing tools" });
  for (const [i, [x, y]] of points.entries()) {
    await tools.getByRole("button", { name: "Add point" }).click();
    await tools.getByLabel(`Point ${i + 1} across (%)`).fill(String(x));
    await tools.getByLabel(`Point ${i + 1} across (%)`).blur();
    await tools.getByLabel(`Point ${i + 1} down (%)`).fill(String(y));
    await tools.getByLabel(`Point ${i + 1} down (%)`).blur();
  }
  return tools;
}

test("site plans: a stored drawing, its scale, shapes by keyboard, the lock, a pin's thread and the PDF", async ({
  page,
}) => {
  const id = uniqueId();
  const title = `Stage Plan ${id}`;
  await signIn(page);
  await page.goto(`/${ORG}/places/site-plans?create=1`);
  const drawer = page.getByRole("dialog", { name: "Add site plan" });
  await drawer.getByLabel("Title").fill(title);
  await drawer.getByRole("button", { name: "Add site plan" }).click();
  const peek = page.getByRole("dialog", { name: "Site plan" });
  await expect(peek.getByRole("heading", { name: title })).toBeVisible();

  // The drawing: a PNG on the plan, scanned Clean, then used.
  await peek
    .getByLabel("Drawing file")
    .setInputFiles({ name: `stage-${id}.png`, mimeType: "image/png", buffer: drawing() });
  await peek.getByRole("button", { name: "Upload", exact: true }).click();
  await slow(peek.getByText("Checking the file for viruses…")).toBeVisible();
  await passAttachmentScans("atlas-e2e-b1");
  await slow(peek.getByRole("button", { name: "Use as drawing" })).toBeEnabled();
  await peek.getByRole("button", { name: "Use as drawing" }).click();
  await slow(peek.getByRole("radio", { name: "Set scale" })).toBeVisible();

  // The scale: 50 ft between (10%, 50%) and (60%, 50%).
  await peek.getByRole("radio", { name: "Set scale" }).click();
  let tools = await typePoints(page, [
    [10, 50],
    [60, 50],
  ]);
  await tools.getByLabel("Real distance").fill("50");
  await tools.getByRole("button", { name: "Save scale" }).click();
  await slow(peek.getByText("Calibrated: 50 ft between two points")).toBeVisible();

  // A route by keyboard: (10%, 10%) to (10%, 60%) measures 25 ft.
  await peek.getByRole("radio", { name: "Route" }).click();
  tools = await typePoints(page, [
    [10, 10],
    [10, 60],
  ]);
  await expect(tools.getByRole("status")).toHaveText("Length: 25 ft");
  await tools.getByLabel("Label").fill("Egress north");
  await tools.getByRole("button", { name: "Save shape" }).click();
  await slow(peek.getByText(/Route: Egress north · 25 ft/)).toBeVisible();

  // An area by keyboard: x 10% to 30%, y 20% to 60% measures 400 sq ft.
  await peek.getByRole("radio", { name: "Area" }).click();
  tools = await typePoints(page, [
    [10, 20],
    [30, 20],
    [30, 60],
    [10, 60],
  ]);
  await expect(tools.getByRole("status")).toContainText("Area: 400 sq ft");
  await tools.getByLabel("Label").fill("Pit");
  await tools.getByRole("button", { name: "Save shape" }).click();
  await slow(peek.getByText(/Area: Pit · 400 sq ft/)).toBeVisible();

  // A pin, then the lock: the layout tools are gone.
  await peek.getByRole("radio", { name: "Pin" }).click();
  tools = await typePoints(page, [[40, 40]]);
  await tools.getByLabel("Label").fill("FOH Mix");
  await tools.getByRole("button", { name: "Place pin" }).click();
  await slow(peek.getByText(/1\. FOH Mix at 40% across, 40% down/)).toBeVisible();
  await expectAccessible(page);
  await peek.getByRole("button", { name: "Lock layout" }).click();
  await peek.getByLabel("Reason").fill("Layout agreed with the venue.");
  await peek.getByRole("button", { name: "Lock layout" }).last().click();
  await slow(
    peek.getByText(
      "This plan is locked. Unlock it to change pins, shapes, the scale or the drawing.",
    ),
  ).toBeVisible();
  await expect(peek.getByRole("radio", { name: "Route" })).toHaveCount(0);
  await expect(peek.getByRole("radio", { name: "Annotate" })).toBeVisible();

  // A comment on the pin with a mention, then Resolve: comments stay open while locked.
  await peek.getByRole("link", { name: "Comments" }).first().click();
  const thread = peek.getByRole("region", { name: /Comments on pin FOH Mix/ });
  await thread.getByLabel("Write a comment").fill("Move the desk two rows back?");
  await thread.getByRole("checkbox").first().check();
  await thread.getByRole("button", { name: "Post" }).click();
  await slow(thread.getByText("Move the desk two rows back?")).toBeVisible();
  await thread.getByRole("button", { name: "Resolve" }).click();
  await slow(thread.getByText("Resolved")).toBeVisible();

  // The PDF export: a tagged PDF of template version 1.
  const exportLink = peek.getByRole("link", { name: "Export PDF" });
  const href = await exportLink.getAttribute("href");
  expect(href).toBeTruthy();
  const response = await page.request.get(href as string);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/pdf");
  expect(response.headers()["x-document-template-version"]).toBe("1");
  await page.keyboard.press("Escape");
  await page.goto(`/${ORG}/places/site-plans`);
  await inBothThemes(page);
});

test("levels: two levels order the plans and the site plan view steps through them", async ({
  page,
}) => {
  const id = uniqueId();
  await signIn(page);
  await page.goto(`/${ORG}/places/venues?view=list`);
  await page
    .getByRole("link")
    .filter({ hasText: /Pavilion|Hall|Arena|Venue/ })
    .first()
    .click();
  const venue = page.getByRole("dialog");
  const levels = venue.getByRole("region", { name: "Levels" });
  await levels.getByLabel("Level").last().fill(`Ground ${id}`);
  await levels.getByLabel("Order (lowest first)").last().fill("0");
  await levels.getByRole("button", { name: "Add level" }).click();
  await slow(levels.getByText("Level saved.")).toBeVisible();
  await levels.getByLabel("Level").last().fill(`Mezzanine ${id}`);
  await levels.getByLabel("Order (lowest first)").last().fill("1");
  await levels.getByRole("button", { name: "Add level" }).click();
  await slow(levels.getByRole("textbox", { name: "Level" }).nth(1)).toHaveValue(`Mezzanine ${id}`);
  await inBothThemes(page);
  await page.goto(`/${ORG}/places/site-plans?view=site-plan`);
  await expect(page.getByTestId("plan-canvas")).toBeVisible();
  await expectAccessible(page);
});

test("specs: venue power and rigging become capabilities that reconciliation meets", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/${ORG}/places/venues?view=list`);
  await page
    .getByRole("link")
    .filter({ hasText: /Pavilion|Hall|Arena|Venue/ })
    .first()
    .click();
  const venue = page.getByRole("dialog");
  const specs = venue.getByRole("region", { name: "Technical specs" });
  await specs.getByLabel("House power (A)").fill("400");
  await specs.getByLabel("Voltage (V)").fill("208");
  await specs.getByLabel("Rigging points").fill("24");
  await specs.getByLabel("Load per point (lb)").fill("2000");
  await expect(specs.getByText("Don't enter passwords.", { exact: false })).toBeVisible();
  await specs.getByRole("button", { name: "Save specs" }).click();
  await slow(specs.getByText("Saved.")).toBeVisible();
  await page.goto(`/${ORG}/p/NWS/scope`);
  await page.getByRole("button", { name: "Add venue specs as capabilities" }).click();
  await slow(page.getByText(/capabilit(y|ies) written from the venue's specs/)).toBeVisible();
  await expect(page.getByText("From venue specs").first()).toBeVisible();
  await inBothThemes(page);
});

test("signage: a sign at a pin, marked printed and placed, moves across the board and prints its build sheet", async ({
  page,
}) => {
  const id = uniqueId();
  const title = `Main entrance arrow ${id}`;
  await signIn(page);
  await page.goto(`/${ORG}/places/signage?create=1`);
  const drawer = page.getByRole("dialog", { name: "Add sign" });
  await drawer.getByLabel("Sign", { exact: true }).fill(title);
  await drawer.getByLabel("Location in words").fill("Gate A, north fence");
  await drawer.getByRole("button", { name: "Add sign" }).click();
  const peek = page.getByRole("dialog", { name: "Sign" });
  await slow(peek.getByText(title)).toBeVisible();
  await peek.getByRole("button", { name: "Mark printed" }).click();
  await slow(peek.getByRole("button", { name: "Undo Mark printed" })).toBeVisible();
  await peek.getByRole("button", { name: "Mark placed" }).click();
  await slow(peek.getByRole("button", { name: "Undo Mark placed" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto(`/${ORG}/places/signage?view=board`);
  const placed = page.getByRole("region", { name: "Placed" });
  await expect(placed.getByText(title)).toBeVisible();
  await inBothThemes(page);
  const sheet = page.getByRole("link", {
    name: /Build sheet \(PDF\)|Choose a project for its build sheet/,
  });
  if ((await sheet.textContent())?.includes("Choose")) await sheet.click();
  const href = await page.getByRole("link", { name: "Build sheet (PDF)" }).getAttribute("href");
  const response = await page.request.get(href as string);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/pdf");
});
