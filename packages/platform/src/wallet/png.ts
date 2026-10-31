/**
 * Pass art from the org's logo (A140, follow-up of A93): the Apple pass's icon, logo and, for a shift pass, its strip
 * are drawn from the logo in the org-brand bucket, on the pass's background color. PNG only, which is what the bucket
 * mostly holds; an SVG, WebP or icon file, or a PNG this decoder does not read (interlaced, or too large), leaves the
 * pass with today's accent icon.
 *
 * No image library (A85): zlib comes from the runtime's DecompressionStream and CompressionStream, which Deno and
 * Node both provide, and resampling is an area average in premultiplied alpha.
 */

/** An image as 8-bit RGBA, row by row. */
export interface Rgba {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** The largest logo decoded, in pixels: a 2 MB org-brand PNG never needs more. */
export const MAX_LOGO_PIXELS = 4096 * 4096;

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const piped = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** The PNG as RGBA, or null when it is not a PNG this decoder reads. */
export async function decodePng(
  png: Uint8Array,
  maxPixels: number = MAX_LOGO_PIXELS,
): Promise<Rgba | null> {
  if (png.length < 8 || SIGNATURE.some((b, i) => png[i] !== b)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 12 <= png.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    if (data.length !== length) return null;
    if (type === "IHDR") {
      if (length < 13) return null;
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      depth = data[8] ?? 0;
      colorType = data[9] ?? -1;
      // Compression and filter method 0 only; interlaced images are not read.
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) return null;
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") transparency = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  const channels = CHANNELS[colorType];
  if (!channels || !DEPTHS[colorType]?.includes(depth)) return null;
  if (width < 1 || height < 1 || width * height > maxPixels) return null;
  if (colorType === 3 && !palette) return null;

  let raw: Uint8Array;
  try {
    const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
    let offset = 0;
    for (const d of idat) {
      joined.set(d, offset);
      offset += d.length;
    }
    raw = await through(joined, new DecompressionStream("deflate"));
  } catch {
    return null;
  }
  const stride = Math.ceil((width * channels * depth) / 8);
  const bpp = Math.max(1, (channels * depth) / 8);
  if (raw.length < (stride + 1) * height) return null;

  // Undo the row filters in place, into one buffer of rows without their filter bytes.
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? (rows[out + x - bpp] as number) : 0;
      const b = y > 0 ? (rows[out - stride + x] as number) : 0;
      const c = x >= bpp && y > 0 ? (rows[out - stride + x - bpp] as number) : 0;
      const v = line[x] as number;
      const predicted =
        filter === 0
          ? 0
          : filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? (a + b) >> 1
                : filter === 4
                  ? paeth(a, b, c)
                  : -1;
      if (predicted < 0) return null;
      rows[out + x] = (v + predicted) & 0xff;
    }
  }

  // A sample of channel `ch` of pixel x on row y, scaled to 8 bits.
  const sample = (y: number, x: number, ch: number): number => {
    const index = x * channels + ch;
    if (depth === 8) return rows[y * stride + index] as number;
    if (depth === 16) return rows[y * stride + index * 2] as number;
    const bit = index * depth;
    const byte = rows[y * stride + (bit >> 3)] as number;
    return (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  const scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1;
  const key =
    transparency && (colorType === 0 || colorType === 2)
      ? Array.from({ length: colorType === 0 ? 1 : 3 }, (_, i) =>
          depth === 16
            ? (transparency[i * 2] as number)
            : ((((transparency[i * 2] as number) << 8) | (transparency[i * 2 + 1] as number)) &
                ((1 << depth) - 1)) *
              scale,
        )
      : null;

  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const i = sample(y, x, 0);
        data[o] = palette?.[i * 3] ?? 0;
        data[o + 1] = palette?.[i * 3 + 1] ?? 0;
        data[o + 2] = palette?.[i * 3 + 2] ?? 0;
        data[o + 3] = transparency?.[i] ?? 255;
        continue;
      }
      const gray = colorType === 0 || colorType === 4;
      const r = sample(y, x, 0) * scale;
      const g = gray ? r : sample(y, x, 1);
      const b = gray ? r : sample(y, x, 2);
      const alpha =
        colorType === 4
          ? sample(y, x, 1)
          : colorType === 6
            ? sample(y, x, 3)
            : key && key[0] === r && (gray || (key[1] === g && key[2] === b))
              ? 0
              : 255;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = alpha;
    }
  }
  return { width, height, data };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An RGBA PNG of the image, deflated. */
export async function encodePng(image: Rgba): Promise<Uint8Array> {
  const stride = image.width * 4;
  const raw = new Uint8Array((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1)
    raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", await through(raw, new CompressionStream("deflate"))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** A canvas of one color (#RRGGBB), or transparent when the color is null. */
export function canvas(width: number, height: number, hex: string | null): Rgba {
  const data = new Uint8Array(width * height * 4);
  if (hex) {
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);
    for (let o = 0; o < data.length; o += 4)
      data.set([rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0, 255], o);
  }
  return { width, height, data };
}

/** The largest size of the image's shape inside a box, at least one pixel each way. */
export function fit(
  image: { readonly width: number; readonly height: number },
  boxWidth: number,
  boxHeight: number,
): { width: number; height: number } {
  const scale = Math.min(boxWidth / image.width, boxHeight / image.height);
  return {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)),
  };
}

/**
 * Draws the image resized into the rectangle (x, y, width, height) of the canvas, over what is there: each pixel the
 * average of the image area it covers, in premultiplied alpha so transparent edges do not darken.
 */
export function draw(
  target: Rgba,
  image: Rgba,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const fx = image.width / width;
  const fy = image.height / height;
  const nx = Math.max(1, Math.ceil(fx));
  const ny = Math.max(1, Math.ceil(fy));
  for (let dy = 0; dy < height; dy += 1) {
    const ty = y + dy;
    if (ty < 0 || ty >= target.height) continue;
    for (let dx = 0; dx < width; dx += 1) {
      const tx = x + dx;
      if (tx < 0 || tx >= target.width) continue;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < ny; j += 1) {
        const sy = Math.min(image.height - 1, Math.floor((dy + (j + 0.5) / ny) * fy));
        for (let i = 0; i < nx; i += 1) {
          const sx = Math.min(image.width - 1, Math.floor((dx + (i + 0.5) / nx) * fx));
          const o = (sy * image.width + sx) * 4;
          const alpha = image.data[o + 3] as number;
          r += (image.data[o] as number) * alpha;
          g += (image.data[o + 1] as number) * alpha;
          b += (image.data[o + 2] as number) * alpha;
          a += alpha;
        }
      }
      if (a === 0) continue;
      const n = nx * ny;
      const srcA = a / n / 255;
      const o = (ty * target.width + tx) * 4;
      const dstA = (target.data[o + 3] as number) / 255;
      const outA = srcA + dstA * (1 - srcA);
      const mix = (src: number, k: number) =>
        Math.round(
          ((src / a) * srcA + (target.data[o + k] as number) * dstA * (1 - srcA)) / (outA || 1),
        );
      target.data[o] = mix(r, 0);
      target.data[o + 1] = mix(g, 1);
      target.data[o + 2] = mix(b, 2);
      target.data[o + 3] = Math.round(outA * 255);
    }
  }
}

/** The image resized to fit inside a box, centered on a canvas of the box's size and color. */
export function centered(
  image: Rgba,
  width: number,
  height: number,
  background: string | null,
  share: number,
): Rgba {
  const out = canvas(width, height, background);
  const size = fit(image, width * share, height * share);
  draw(
    out,
    image,
    Math.round((width - size.width) / 2),
    Math.round((height - size.height) / 2),
    size.width,
    size.height,
  );
  return out;
}
