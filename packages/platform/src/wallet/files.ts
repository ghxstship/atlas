/**
 * The files of an Apple Wallet pass (A93, RRR-138): a .pkpass is a zip of pass.json, the images, the
 * manifest (each file's SHA-1) and the signature. Wallet reads stored (uncompressed) entries, so the zip
 * here stores; the icon is a solid PNG in the org's accent until the owner supplies pass art, and its
 * zlib stream uses stored blocks. No compression library is needed in the Edge runtime.
 */
import { concat } from "./der.ts";

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
  let crc = 0xffffffff;
  for (const b of bytes) crc = (CRC_TABLE[(crc ^ b) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff);
}

function u32(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

/** A zip of stored entries, in the order given. */
export function storedZip(
  files: readonly { readonly name: string; readonly data: Uint8Array }[],
): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const crc = crc32(file.data);
    // Version 2.0, no flags, stored, a fixed DOS time (1 Jan 2026) so a pass's bytes depend on its content.
    const common = concat(
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0x5c21),
      u32(crc),
      u32(file.data.length),
      u32(file.data.length),
      u16(name.length),
    );
    const local = concat(u32(0x04034b50), common, u16(0), name, file.data);
    centrals.push(
      concat(
        u32(0x02014b50),
        u16(20),
        common,
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ),
    );
    locals.push(local);
    offset += local.length;
  }
  const central = concat(...centrals);
  const end = concat(
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.length),
    u32(offset),
    u16(0),
  );
  return concat(...locals, central, end);
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

/** A zlib stream of stored deflate blocks. */
function zlibStored(data: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
  let at = 0;
  do {
    const block = data.subarray(at, at + 65535);
    at += 65535;
    const last = at >= data.length;
    blocks.push(Uint8Array.of(last ? 1 : 0), u16(block.length), u16(~block.length & 0xffff), block);
  } while (at < data.length);
  const sum = adler32(data);
  blocks.push(
    Uint8Array.of((sum >>> 24) & 0xff, (sum >>> 16) & 0xff, (sum >>> 8) & 0xff, sum & 0xff),
  );
  return concat(...blocks);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typed = concat(new TextEncoder().encode(type), data);
  const crc = crc32(typed);
  const length = data.length;
  return concat(
    Uint8Array.of(
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
    ),
    typed,
    Uint8Array.of((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff),
  );
}

/** A square PNG of one color (#RRGGBB), RGB without alpha. */
export function solidPng(size: number, hex: string): Uint8Array {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);
  const row = new Uint8Array(1 + size * 3);
  for (let x = 0; x < size; x += 1) row.set(rgb, 1 + x * 3);
  const raw = new Uint8Array(row.length * size);
  for (let y = 0; y < size; y += 1) raw.set(row, y * row.length);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header.set([8, 2, 0, 0, 0], 8);
  return concat(
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk("IHDR", header),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array(0)),
  );
}

/** Lowercase hex SHA-1 of bytes (the pass manifest's digest). */
export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes as BufferSource));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
