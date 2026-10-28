import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAPTURE,
  baselineDir,
  compareFolders,
  compareImages,
  decodePng,
  deviceMismatch,
  downscale,
  encodePng,
  TOLERANCE,
  updateBaselines,
  type Image,
} from "../scripts/gallery-compare";

const DEVICE = { device: "iPhone 17 Pro", runtime: "iOS 26.5", scale: 3 };

/** A page-like image: a flat canvas with a card and a line of "text". */
function page(width: number, height: number, tweak?: (x: number, y: number) => number[] | null) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const card = x > 4 && x < width - 4 && y > 6 && y < 30;
      const text = card && y > 12 && y < 15 && x % 3 !== 0;
      const rgba =
        tweak?.(x, y) ??
        (text ? [240, 240, 240, 255] : card ? [40, 42, 48, 255] : [14, 15, 17, 255]);
      data.set(rgba, (y * width + x) * 4);
    }
  }
  return { width, height, data } satisfies Image;
}

const dirs: string[] = [];
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "gallery-compare-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PNG codec", () => {
  it("round-trips an RGBA image", () => {
    const image = page(30, 40);
    const back = decodePng(encodePng(image));
    expect(back.width).toBe(30);
    expect(back.height).toBe(40);
    expect(Buffer.from(back.data).equals(Buffer.from(image.data))).toBe(true);
  });

  it("decodes RGB rows under every filter, as a simulator writes them", () => {
    // Two pixels per row, three rows: None, Sub, Average and Paeth filters on RGB.
    const rows = [
      [0, 10, 20, 30, 40, 50, 60],
      [1, 10, 20, 30, 5, 5, 5],
      [3, 20, 30, 40, 10, 10, 10],
      [4, 1, 1, 1, 1, 1, 1],
    ];
    const header = Buffer.alloc(13);
    header.writeUInt32BE(2, 0);
    header.writeUInt32BE(rows.length, 4);
    header[8] = 8;
    header[9] = 2;
    const png = encodePng({ width: 1, height: 1, data: new Uint8Array(4) });
    // Swap in an RGB header and body around the encoder's chunks.
    const ihdrAt = 8;
    const crcless = (type: string, body: Buffer) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(body.length, 0);
      head.write(type, 4, "latin1");
      return Buffer.concat([head, body, Buffer.alloc(4)]);
    };
    const rgb = Buffer.concat([
      png.subarray(0, ihdrAt),
      crcless("IHDR", header),
      crcless("IDAT", deflateSync(Buffer.from(rows.flat()))),
      crcless("IEND", Buffer.alloc(0)),
    ]);
    const image = decodePng(rgb);
    expect([...image.data.subarray(0, 8)]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    // Sub: the second pixel adds the first.
    expect([...image.data.subarray(8, 16)]).toEqual([10, 20, 30, 255, 15, 25, 35, 255]);
    // Average of left and up.
    expect([...image.data.subarray(16, 20)]).toEqual([25, 40, 55, 255]);
    expect(image.data[20]).toBe(10 + ((25 + 15) >> 1));
    expect(image.data[24]).toBe(26);
  });

  it("refuses files it cannot read", () => {
    expect(() => decodePng(Buffer.from("not a png"))).toThrow(/not a PNG/);
  });
});

describe("downscale", () => {
  it("averages blocks of pixels into one", () => {
    const image = page(6, 3, (x) => (x < 3 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const small = downscale(image, 3);
    expect(small.width).toBe(2);
    expect(small.height).toBe(1);
    expect([...small.data]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
    expect(downscale(image, 1)).toBe(image);
    expect(() => downscale(image, 0)).toThrow();
  });
});

describe("compareImages", () => {
  const base = page(120, 80);

  it("passes the same page", () => {
    const result = compareImages(base, page(120, 80));
    expect(result.pass).toBe(true);
    expect(result.differing).toBe(0);
  });

  it("absorbs anti-aliasing noise within the channel allowance", () => {
    const noisy = page(120, 80, (x, y) => (x === 10 && y === 13 ? [228, 230, 236, 255] : null));
    const result = compareImages(base, noisy);
    expect(result.pass).toBe(true);
    expect(result.maxDelta).toBeLessThanOrEqual(TOLERANCE.channel);
  });

  it("fails a changed component: a color, a size or a label", () => {
    const recolored = page(120, 80, (x, y) =>
      x > 4 && x < 116 && y > 6 && y < 30 ? [60, 42, 48, 255] : null,
    );
    expect(compareImages(base, recolored).pass).toBe(false);
    // One point taller card: a single extra row of pixels.
    const taller = page(120, 80, (x, y) =>
      x > 4 && x < 116 && y === 30 ? [40, 42, 48, 255] : null,
    );
    const result = compareImages(base, taller);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/pixels differ/);
    expect(result.diff?.data[(30 * 120 + 50) * 4]).toBe(255);
  });

  it("fails a page of another size", () => {
    const result = compareImages(base, page(120, 81));
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/size 120x81/);
  });
});

describe("deviceMismatch", () => {
  it("compares only captures from the baselines' simulator and runtime", () => {
    expect(deviceMismatch(DEVICE, DEVICE)).toBeNull();
    expect(deviceMismatch(DEVICE, { ...DEVICE, runtime: "iOS 26.3" })).toMatch(/iOS 26.3/);
    expect(deviceMismatch(DEVICE, { ...DEVICE, scale: 2 })).toMatch(/scale 2/);
  });
});

describe("compareFolders and updateBaselines", () => {
  function captures(names: string[], tweak?: (x: number, y: number) => number[] | null) {
    const dir = folder();
    writeFileSync(join(dir, "capture.json"), JSON.stringify(DEVICE));
    for (const name of names) writeFileSync(join(dir, name), encodePng(page(360, 240, tweak)));
    return dir;
  }

  it("records baselines at one pixel per point and matches a second run", () => {
    const baselines = folder();
    const first = captures(["gallery-dark-01.png", "gallery-light-01.png", "notes.txt"]);
    expect(updateBaselines(first, baselines)).toEqual([
      "gallery-dark-01.png",
      "gallery-light-01.png",
    ]);
    const kept = decodePng(readFileSync(join(baselines, "gallery-dark-01.png")));
    expect([kept.width, kept.height]).toEqual([120, 80]);
    expect(JSON.parse(readFileSync(join(baselines, "manifest.json"), "utf8"))).toEqual(DEVICE);
    const second = captures(["gallery-dark-01.png", "gallery-light-01.png"]);
    const result = compareFolders(second, baselines);
    expect(result.mismatch).toBeNull();
    expect(result.pages.map((p) => p.pass)).toEqual([true, true]);
  });

  it("fails a changed page, a new page and a missing page, and writes the diff", () => {
    const baselines = folder();
    updateBaselines(captures(["gallery-dark-01.png", "gallery-dark-02.png"]), baselines);
    const changed = captures(["gallery-dark-01.png", "gallery-dark-03.png"], (x, y) =>
      x > 30 && x < 90 && y > 30 && y < 60 ? [200, 60, 60, 255] : null,
    );
    const { pages } = compareFolders(changed, baselines);
    expect(pages).toEqual([
      expect.objectContaining({ name: "gallery-dark-01.png", pass: false }),
      expect.objectContaining({ name: "gallery-dark-02.png", pass: false, detail: "not captured" }),
      expect.objectContaining({ name: "gallery-dark-03.png", pass: false }),
    ]);
    expect(existsSync(join(changed, "gallery-dark-01.diff.png"))).toBe(true);
  });

  it("refuses captures from another simulator", () => {
    const baselines = folder();
    updateBaselines(captures(["gallery-dark-01.png"]), baselines);
    const other = captures(["gallery-dark-01.png"]);
    writeFileSync(join(other, "capture.json"), JSON.stringify({ ...DEVICE, device: "iPhone 16" }));
    const result = compareFolders(other, baselines);
    expect(result.mismatch).toMatch(/iPhone 16/);
    expect(result.pages).toEqual([]);
  });

  it("drops the baseline of a page the gallery no longer has", () => {
    const baselines = folder();
    updateBaselines(captures(["gallery-dark-01.png", "gallery-dark-02.png"]), baselines);
    updateBaselines(captures(["gallery-dark-01.png"]), baselines);
    expect(readdirSync(baselines).filter((f) => CAPTURE.test(f))).toEqual(["gallery-dark-01.png"]);
  });
});

describe("the kept baselines", () => {
  it("cover both themes with the same pages, recorded at one pixel per point", () => {
    const manifest = JSON.parse(
      readFileSync(join(baselineDir, "manifest.json"), "utf8"),
    ) as typeof DEVICE;
    expect(manifest.scale).toBeGreaterThan(1);
    const files = readdirSync(baselineDir).filter((f) => CAPTURE.test(f));
    const dark = files.filter((f) => f.includes("-dark-")).map((f) => f.replace("-dark-", "-"));
    const light = files.filter((f) => f.includes("-light-")).map((f) => f.replace("-light-", "-"));
    expect(dark.length).toBeGreaterThan(20);
    expect(dark).toEqual(light);
    const first = decodePng(readFileSync(join(baselineDir, files[0] ?? "")));
    expect(first.width).toBeLessThan(500);
  });
});
