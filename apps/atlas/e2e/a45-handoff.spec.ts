import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import { parseHandoffUrl } from "@xos/ia/handoff";
import { DEMO_ORG, signInAs } from "./a36-support";

/**
 * Journey 58 (Section 20.2, Section 11.10 item 13, ADR 0030), the Atlas half: the Demo Field Lead opens
 * an Inspection record, opens Continue on another device, and the QR code, decoded from the pixels
 * the page draws, carries the link that opens the same record in Compass. With E2E_HANDOFF_OUT set the
 * decoded link is written there, and the Compass half (apps/compass/.maestro/flows/handoff-open-record)
 * opens it on the iOS simulator and asserts the same record is shown.
 */
const RECORD = { key: "NWS-14", title: "Fire Marshal Walk" };
const jsQrPath = createRequire(import.meta.url).resolve("jsqr/dist/jsQR.js");

test("journey 58: the Continue on another device QR code opens the same record in Compass", async ({
  page,
}) => {
  await signInAs(page, "field@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/r/${RECORD.key}`);
  await expect(page.getByRole("heading", { level: 1, name: RECORD.title })).toBeVisible();

  // No QR encoder ships with the page: the code loads when the control opens.
  await expect(page.locator("[data-handoff-qr]")).toHaveCount(0);
  await page.getByRole("button", { name: "Continue on phone" }).click();
  const dialog = page.getByRole("dialog", { name: "Continue on another device" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(`open ${RECORD.key} in Compass`)).toBeVisible();
  const qr = dialog.getByRole("img", {
    name: `QR code that opens ${RECORD.key} · ${RECORD.title} in Compass`,
  });
  await expect(qr).toBeVisible();

  // Read the code the way a phone camera does: rasterize the drawn SVG and decode its modules.
  await page.addScriptTag({ path: jsQrPath });
  const decoded = await page.evaluate(async () => {
    const svg = document.querySelector("[data-handoff-qr] svg");
    if (!svg) throw new Error("no QR code drawn");
    const clone = svg.cloneNode(true) as SVGSVGElement;
    // Inline the theme colors the classes resolve to, so the standalone image keeps them.
    const [quiet, ink] = [svg.querySelector("rect"), svg.querySelector("path")];
    clone.querySelector("rect")?.setAttribute("fill", getComputedStyle(quiet as Element).fill);
    clone.querySelector("path")?.setAttribute("fill", getComputedStyle(ink as Element).fill);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", "640");
    clone.setAttribute("height", "640");
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(clone.outerHTML)}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 640;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no canvas");
    context.drawImage(image, 0, 0, 640, 640);
    const pixels = context.getImageData(0, 0, 640, 640);
    const jsQR = (
      window as unknown as {
        jsQR: (d: Uint8ClampedArray, w: number, h: number) => { data: string } | null;
      }
    ).jsQR;
    return jsQR(pixels.data, pixels.width, pixels.height)?.data ?? null;
  });

  expect(decoded, "the QR code decodes").not.toBeNull();
  const link = decoded as string;
  // Universal links are the owner's step (ADR 0030); until then the code carries the Compass scheme link.
  expect(link).toBe(`compass://r/${RECORD.key}?org=${DEMO_ORG}`);
  await expect(dialog.locator("[data-handoff-url]")).toHaveText(link);
  expect(parseHandoffUrl(link)).toEqual({ kind: "record", org: DEMO_ORG, recordKey: RECORD.key });

  // Without the owner's Apple and Android identities, no universal link file claims the app.
  expect((await page.request.get("/.well-known/apple-app-site-association")).status()).toBe(404);
  expect((await page.request.get("/.well-known/assetlinks.json")).status()).toBe(404);

  const out = process.env["E2E_HANDOFF_OUT"];
  if (out) writeFileSync(out, `${link}\n`);
});
