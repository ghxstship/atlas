/**
 * The signature a person draws on the SignaturePad (an SVG path of `M x y` and `L x y` commands in view
 * points) as a PNG, because field-media accepts images only (0368). The strokes are fitted into a
 * fixed canvas and drawn black on white with a round pen, then encoded as an 8-bit grayscale PNG with
 * stored deflate blocks, so the device needs no native image module and the result is deterministic.
 */

export const SIGNATURE_WIDTH = 600;
export const SIGNATURE_HEIGHT = 200;
const PADDING = 12;
const PEN_RADIUS = 2;

type Point = readonly [number, number];

/** The strokes of an SVG path made of M and L commands; anything else is ignored. */
export function parseStrokes(path: string): Point[][] {
  const strokes: Point[][] = [];
  const pattern = /([ML])\s*(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)/g;
  for (const m of path.matchAll(pattern)) {
    const point: Point = [Number(m[2]), Number(m[3])];
    if (m[1] === "M" || strokes.length === 0) strokes.push([point]);
    else strokes[strokes.length - 1]?.push(point);
  }
  return strokes;
}

/** A grayscale canvas (255 white, 0 ink) with the strokes fitted inside the padding. */
export function rasterize(
  path: string,
  width = SIGNATURE_WIDTH,
  height = SIGNATURE_HEIGHT,
): Uint8Array {
  const pixels = new Uint8Array(width * height).fill(255);
  const strokes = parseStrokes(path);
  const all = strokes.flat();
  if (all.length === 0) return pixels;
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const scale = Math.min(
    (width - 2 * PADDING) / Math.max(maxX - minX, 1),
    (height - 2 * PADDING) / Math.max(maxY - minY, 1),
  );
  const fit = (p: Point): Point => [
    PADDING + (p[0] - minX) * scale,
    PADDING + (p[1] - minY) * scale,
  ];
  const dot = (cx: number, cy: number) => {
    for (let y = Math.floor(cy - PEN_RADIUS); y <= Math.ceil(cy + PEN_RADIUS); y += 1) {
      for (let x = Math.floor(cx - PEN_RADIUS); x <= Math.ceil(cx + PEN_RADIUS); x += 1) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        if ((x - cx) ** 2 + (y - cy) ** 2 <= PEN_RADIUS ** 2) pixels[y * width + x] = 0;
      }
    }
  };
  for (const stroke of strokes) {
    const points = stroke.map(fit);
    const first = points[0];
    if (!first) continue;
    dot(first[0], first[1]);
    for (let i = 1; i < points.length; i += 1) {
      const [x0, y0] = points[i - 1] as Point;
      const [x1, y1] = points[i] as Point;
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
      for (let s = 1; s <= steps; s += 1)
        dot(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps);
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function chunk(type: string, data: Uint8Array): number[] {
  const typed = new Uint8Array([...[...type].map((c) => c.charCodeAt(0)), ...data]);
  return [...u32(data.length), ...typed, ...u32(crc32(typed))];
}

/** zlib with stored (uncompressed) deflate blocks of at most 65535 bytes. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const out: number[] = [0x78, 0x01];
  let start = 0;
  do {
    const end = Math.min(start + 65535, raw.length);
    const size = end - start;
    out.push(end >= raw.length ? 1 : 0, size & 255, size >>> 8, ~size & 255, (~size >>> 8) & 255);
    for (let i = start; i < end; i += 1) out.push(raw[i] as number);
    start = end;
  } while (start < raw.length);
  out.push(...u32(adler32(raw)));
  return new Uint8Array(out);
}

/** An 8-bit grayscale PNG of the canvas. */
export function encodePng(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const header = new Uint8Array([...u32(width), ...u32(height), 8, 0, 0, 0, 0]);
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk("IHDR", header),
    ...chunk("IDAT", zlibStored(raw)),
    ...chunk("IEND", new Uint8Array()),
  ]);
}

export function signaturePng(path: string): Uint8Array {
  return encodePng(rasterize(path), SIGNATURE_WIDTH, SIGNATURE_HEIGHT);
}
