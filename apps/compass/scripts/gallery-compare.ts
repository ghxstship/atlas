/**
 * Compares the component gallery's Maestro captures with the kept baselines (A141, S11.4-01).
 *
 *   node --experimental-strip-types scripts/gallery-compare.ts <captures-dir>           compare
 *   node --experimental-strip-types scripts/gallery-compare.ts <captures-dir> --update  re-record
 *
 * <captures-dir> holds gallery-<theme>-NN.png from .maestro/flows/gallery-*.yaml and the capture.json that
 * scripts/gallery-snapshots.sh writes beside them (simulator, runtime, scale). Baselines live in
 * .maestro/gallery/baselines with a manifest.json naming the simulator and runtime they were taken on.
 *
 * Baselines are kept at one pixel per point: each capture is averaged over scale x scale blocks (3 x 3 on
 * the iPhone 17 Pro) before it is stored or compared. That keeps the baselines small and still shows a
 * change of one point.
 *
 * Tolerance (TOLERANCE below). A pixel differs when any of its red, green, blue or alpha values moves by
 * more than 16 of 255; a page fails when more than 0.01 % of its pixels differ (35 of the 351,348 on an
 * iPhone 17 Pro page). The per-pixel allowance absorbs anti-aliasing noise on the edges of text and
 * shapes; the page allowance absorbs a few stray edge pixels. A changed color, size, spacing, label or
 * icon moves far more than that. Two runs on the same simulator measure the noise this has to absorb;
 * .maestro/gallery/README.md records the last measurement.
 *
 * A capture from another simulator or runtime is not compared: fonts and rendering differ between iOS
 * versions, so it would fail for the wrong reason. Re-record on that simulator instead.
 *
 * Exits 0 when every page matches, 1 when a page differs, a page is missing on either side, or the
 * simulator does not match. A differing page also gets <name>.diff.png in the captures folder: the
 * baseline dimmed, with the differing pixels in red.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

export const TOLERANCE = {
  /** Largest change of one channel (0 to 255) that still counts as the same pixel. */
  channel: 16,
  /** Largest share of a page's pixels that may differ. */
  ratio: 0.0001,
} as const;

export const baselineDir = fileURLToPath(new URL("../.maestro/gallery/baselines", import.meta.url));

/** A gallery capture's file name: gallery-dark-01.png. */
export const CAPTURE = /^gallery-(dark|light)-\d{2}\.png$/;

export interface Image {
  readonly width: number;
  readonly height: number;
  /** RGBA, 8 bits per channel, row by row. */
  readonly data: Uint8Array;
}

export interface Device {
  /** The simulator's device type, such as "iPhone 17 Pro". */
  readonly device: string;
  /** The simulator runtime, such as "iOS 26.5". */
  readonly runtime: string;
  /** Pixels per point of the captures. */
  readonly scale: number;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decodes an 8-bit, non-interlaced RGB, RGBA, grey or grey-alpha PNG, which is what a simulator writes. */
export function decodePng(png: Uint8Array): Image {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at < buf.length;) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      colorType = body[9] ?? 0;
      if (depth !== 8) throw new Error(`PNG bit depth ${depth} is not supported (8 only)`);
      if (body[12] !== 0) throw new Error("interlaced PNGs are not supported");
      if (![0, 2, 4, 6].includes(colorType))
        throw new Error(`PNG color type ${colorType} is not supported`);
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType] ?? 4;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? (rows[y * stride + x - channels] ?? 0) : 0;
      const up = y > 0 ? (rows[(y - 1) * stride + x] ?? 0) : 0;
      const corner = y > 0 && x >= channels ? (rows[(y - 1) * stride + x - channels] ?? 0) : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - corner);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      } else if (filter !== 0) throw new Error(`PNG filter ${filter} is not valid`);
      rows[y * stride + x] = ((line[x] ?? 0) + predictor) & 0xff;
    }
  }
  if (channels === 4) return { width, height, data: rows };
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const src = i * channels;
    const grey = channels <= 2;
    data[i * 4] = rows[src] ?? 0;
    data[i * 4 + 1] = rows[grey ? src : src + 1] ?? 0;
    data[i * 4 + 2] = rows[grey ? src : src + 2] ?? 0;
    data[i * 4 + 3] = channels === 2 ? (rows[src + 1] ?? 255) : 255;
  }
  return { width, height, data };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** Encodes an RGBA PNG; each row uses the Up filter, which suits flat screens. */
export function encodePng(image: Image): Buffer {
  const { width, height, data } = image;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 2;
    for (let x = 0; x < stride; x++) {
      const up = y > 0 ? (data[(y - 1) * stride + x] ?? 0) : 0;
      raw[y * (stride + 1) + 1 + x] = ((data[y * stride + x] ?? 0) - up) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Averages each factor x factor block into one pixel; a partial block at the edge is dropped. */
export function downscale(image: Image, factor: number): Image {
  if (!Number.isInteger(factor) || factor < 1) throw new Error(`scale ${factor} is not valid`);
  if (factor === 1) return image;
  const width = Math.floor(image.width / factor);
  const height = Math.floor(image.height / factor);
  const data = new Uint8Array(width * height * 4);
  const area = factor * factor;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++) {
          for (let dx = 0; dx < factor; dx++) {
            sum += image.data[((y * factor + dy) * image.width + x * factor + dx) * 4 + c] ?? 0;
          }
        }
        data[(y * width + x) * 4 + c] = Math.round(sum / area);
      }
    }
  }
  return { width, height, data };
}

export interface Comparison {
  readonly pass: boolean;
  readonly differing: number;
  readonly ratio: number;
  /** The largest channel change found anywhere on the page. */
  readonly maxDelta: number;
  readonly reason?: string;
  /** The baseline dimmed with the differing pixels in red; set when the sizes match. */
  readonly diff?: Image;
}

/** Compares a capture with its baseline under the tolerance. */
export function compareImages(
  baseline: Image,
  capture: Image,
  tolerance: { channel: number; ratio: number } = TOLERANCE,
): Comparison {
  if (baseline.width !== capture.width || baseline.height !== capture.height) {
    return {
      pass: false,
      differing: baseline.width * baseline.height,
      ratio: 1,
      maxDelta: 255,
      reason: `size ${capture.width}x${capture.height}, baseline ${baseline.width}x${baseline.height}`,
    };
  }
  const pixels = baseline.width * baseline.height;
  const diff = new Uint8Array(pixels * 4);
  let differing = 0;
  let maxDelta = 0;
  for (let i = 0; i < pixels; i++) {
    let delta = 0;
    for (let c = 0; c < 4; c++) {
      delta = Math.max(
        delta,
        Math.abs((baseline.data[i * 4 + c] ?? 0) - (capture.data[i * 4 + c] ?? 0)),
      );
    }
    maxDelta = Math.max(maxDelta, delta);
    const off = delta > tolerance.channel;
    if (off) differing += 1;
    for (let c = 0; c < 3; c++) {
      const dimmed = Math.round((baseline.data[i * 4 + c] ?? 0) * 0.3);
      diff[i * 4 + c] = off ? (c === 0 ? 255 : 0) : dimmed;
    }
    diff[i * 4 + 3] = 255;
  }
  const ratio = differing / pixels;
  const pass = ratio <= tolerance.ratio;
  return {
    pass,
    differing,
    ratio,
    maxDelta,
    ...(pass
      ? {}
      : {
          reason: `${differing} pixels differ (${(ratio * 100).toFixed(3)} %, allowed ${(tolerance.ratio * 100).toFixed(3)} %)`,
        }),
    diff: { width: baseline.width, height: baseline.height, data: diff },
  };
}

export interface PageResult {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

/** Why captures from `capture` cannot be compared with baselines from `baseline`; null when they can. */
export function deviceMismatch(baseline: Device, capture: Device): string | null {
  if (baseline.device === capture.device && baseline.runtime === capture.runtime) {
    return baseline.scale === capture.scale
      ? null
      : `scale ${capture.scale}, baselines ${baseline.scale}`;
  }
  return `captured on ${capture.device}, ${capture.runtime}; the baselines are for ${baseline.device}, ${baseline.runtime}`;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** Compares every capture in `captures` with `baselines`; a page missing on either side fails. */
export function compareFolders(
  captures: string,
  baselines: string = baselineDir,
  tolerance: { channel: number; ratio: number } = TOLERANCE,
): { mismatch: string | null; pages: PageResult[] } {
  const manifest = readJson<Device>(join(baselines, "manifest.json"));
  const device = readJson<Device>(join(captures, "capture.json"));
  const mismatch = deviceMismatch(manifest, device);
  if (mismatch) return { mismatch, pages: [] };
  const taken = readdirSync(captures).filter((f) => CAPTURE.test(f));
  const kept = readdirSync(baselines).filter((f) => CAPTURE.test(f));
  const names = [...new Set([...taken, ...kept])].sort();
  const pages = names.map((name): PageResult => {
    if (!kept.includes(name)) return { name, pass: false, detail: "no baseline (new page?)" };
    if (!taken.includes(name)) return { name, pass: false, detail: "not captured" };
    const baseline = decodePng(readFileSync(join(baselines, name)));
    const capture = downscale(decodePng(readFileSync(join(captures, name))), device.scale);
    const result = compareImages(baseline, capture, tolerance);
    if (!result.pass && result.diff) {
      writeFileSync(join(captures, name.replace(/\.png$/, ".diff.png")), encodePng(result.diff));
    }
    return {
      name,
      pass: result.pass,
      detail:
        result.reason ??
        `${result.differing} pixels differ, largest channel change ${result.maxDelta}`,
    };
  });
  return { mismatch: null, pages };
}

/** Re-records the baselines from `captures`: the downscaled pages and the manifest. */
export function updateBaselines(captures: string, baselines: string = baselineDir): string[] {
  const device = readJson<Device>(join(captures, "capture.json"));
  mkdirSync(baselines, { recursive: true });
  // A page the gallery no longer has loses its baseline.
  for (const old of readdirSync(baselines).filter((f) => CAPTURE.test(f))) {
    if (!existsSync(join(captures, old))) rmSync(join(baselines, old));
  }
  const taken = readdirSync(captures)
    .filter((f) => CAPTURE.test(f))
    .sort();
  for (const name of taken) {
    const image = downscale(decodePng(readFileSync(join(captures, name))), device.scale);
    writeFileSync(join(baselines, name), encodePng(image));
  }
  const manifest: Device = { device: device.device, runtime: device.runtime, scale: device.scale };
  writeFileSync(join(baselines, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return taken;
}

function main(argv: string[]): number {
  const update = argv.includes("--update");
  const captures = argv.find((a) => !a.startsWith("--"));
  if (!captures) {
    console.error("usage: gallery-compare.ts <captures-dir> [--update]");
    return 2;
  }
  if (update) {
    const taken = updateBaselines(captures);
    console.log(`Recorded ${taken.length} baselines in ${baselineDir}`);
    return taken.length > 0 ? 0 : 1;
  }
  if (!existsSync(join(baselineDir, "manifest.json"))) {
    console.error(`No baselines in ${baselineDir}; record them with --update.`);
    return 1;
  }
  const { mismatch, pages } = compareFolders(captures);
  if (mismatch) {
    console.error(`Not compared: ${mismatch}. Run on that simulator, or re-record with --update.`);
    return 1;
  }
  for (const page of pages)
    console.log(`${page.pass ? "same" : "DIFF"}  ${page.name}  ${page.detail}`);
  const failed = pages.filter((p) => !p.pass).length;
  console.log(
    failed === 0
      ? `All ${pages.length} gallery pages match the baselines.`
      : `${failed} of ${pages.length} gallery pages differ; see the .diff.png files in ${captures}.`,
  );
  return failed === 0 && pages.length > 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
