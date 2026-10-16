/**
 * Content checks that run before the virus scan (A22-011, Section 9 "MIME sniffing"): the file's
 * leading bytes must match the type it was uploaded as, its extension must belong to that type, and
 * a zip archive must stay within the unpacked size and entry limits and contain no nested archive.
 * A file that fails is refused (recorded as Scan Failed with the reason) and never served.
 */

export type ContentCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Zip limits: unpacked size, entries and compression ratio, so an archive cannot be a zip bomb. */
export const ZIP_LIMITS = {
  maxUnpackedBytes: 100 * 1024 * 1024,
  maxEntries: 1000,
  maxRatio: 100,
} as const;

type Family =
  "pdf" | "jpeg" | "png" | "gif" | "webp" | "heic" | "mp4" | "mp3" | "zip" | "ole" | "ico" | "text";

interface TypeRule {
  readonly families: readonly Family[];
  readonly extensions: readonly string[];
}

/** Every type an upload bucket accepts, with the byte signature families and extensions it may have. */
const TYPES: Readonly<Record<string, TypeRule>> = {
  "application/pdf": { families: ["pdf"], extensions: ["pdf"] },
  "image/jpeg": { families: ["jpeg"], extensions: ["jpg", "jpeg"] },
  "image/png": { families: ["png"], extensions: ["png"] },
  "image/gif": { families: ["gif"], extensions: ["gif"] },
  "image/webp": { families: ["webp"], extensions: ["webp"] },
  "image/heic": { families: ["heic"], extensions: ["heic", "heif"] },
  "image/x-icon": { families: ["ico"], extensions: ["ico"] },
  "image/vnd.microsoft.icon": { families: ["ico"], extensions: ["ico"] },
  "text/plain": { families: ["text"], extensions: ["txt", "text", "log", "md"] },
  "text/csv": { families: ["text"], extensions: ["csv"] },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    families: ["zip"],
    extensions: ["docx"],
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    families: ["zip"],
    extensions: ["xlsx"],
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    families: ["zip"],
    extensions: ["pptx"],
  },
  "application/msword": { families: ["ole"], extensions: ["doc"] },
  "application/vnd.ms-excel": { families: ["ole"], extensions: ["xls"] },
  "application/vnd.ms-powerpoint": { families: ["ole"], extensions: ["ppt"] },
  "video/mp4": { families: ["mp4"], extensions: ["mp4", "m4v"] },
  "video/quicktime": { families: ["mp4"], extensions: ["mov", "qt"] },
  "audio/mpeg": { families: ["mp3"], extensions: ["mp3"] },
  "application/zip": { families: ["zip"], extensions: ["zip"] },
};

/** Types that are zip containers by design: inspected for limits, but may embed other containers. */
const OFFICE_ZIPS = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const NESTED_ARCHIVE =
  /\.(zip|zipx|jar|war|apk|7z|rar|gz|tgz|tar|bz2|tbz2|xz|txz|zst|lz|lzma|cab|iso|dmg|arj|z)$/i;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(
      sample.length === bytes.length ? sample : bytes,
    );
    return true;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

/** The signature families the leading bytes match. */
export function sniffFamilies(bytes: Uint8Array): Family[] {
  const found: Family[] = [];
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) found.push("pdf");
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) found.push("jpeg");
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) found.push("png");
  if (["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) found.push("gif");
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") found.push("webp");
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heim", "heis"].includes(brand)) {
      found.push("heic");
    } else {
      found.push("mp4");
    }
  }
  if (
    startsWith(bytes, [0x49, 0x44, 0x33]) ||
    (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
  ) {
    found.push("mp3");
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    found.push("zip");
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) found.push("ole");
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) found.push("ico");
  if (found.length === 0 && looksLikeText(bytes)) found.push("text");
  return found;
}

function extensionOf(filename: string): string {
  const match = /\.([^./\\]+)$/.exec(filename);
  return (match?.[1] ?? "").toLowerCase();
}

interface ZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly encrypted: boolean;
}

/** Reads a zip's central directory. Returns a reason string when the archive cannot be read safely. */
export function readZipDirectory(bytes: Uint8Array): ZipEntry[] | string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minEnd = Math.max(0, bytes.length - 22 - 65535);
  let end = -1;
  for (let i = bytes.length - 22; i >= minEnd; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return "The archive has no zip directory.";
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const offset = view.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    return "ZIP64 archives are not accepted.";
  }
  if (offset + size > end) return "The zip directory is damaged.";
  const entries: ZipEntry[] = [];
  let at = offset;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50)
      return "The zip directory is damaged.";
    const flags = view.getUint16(at + 8, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      return "ZIP64 archives are not accepted.";
    }
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.push({ name, compressedSize, uncompressedSize, encrypted: (flags & 1) === 1 });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Applies the zip limits; nested archives are refused unless the type is an Office container. */
export function checkZip(bytes: Uint8Array, allowNested: boolean): ContentCheck {
  const entries = readZipDirectory(bytes);
  if (typeof entries === "string") return { ok: false, reason: entries };
  if (entries.length > ZIP_LIMITS.maxEntries) {
    return { ok: false, reason: `The archive has more than ${ZIP_LIMITS.maxEntries} entries.` };
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.encrypted)
      return { ok: false, reason: "Encrypted archive entries cannot be scanned." };
    if (entry.name.startsWith("/") || entry.name.split(/[/\\]/).includes("..")) {
      return { ok: false, reason: "The archive has an entry outside its own folder." };
    }
    if (!allowNested && NESTED_ARCHIVE.test(entry.name)) {
      return { ok: false, reason: "Archives inside archives are not accepted." };
    }
    if (
      entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize > ZIP_LIMITS.maxRatio
    ) {
      return { ok: false, reason: "An archive entry is compressed beyond the allowed ratio." };
    }
    if (entry.compressedSize === 0 && entry.uncompressedSize > 0) {
      return { ok: false, reason: "An archive entry declares content with no stored bytes." };
    }
    total += entry.uncompressedSize;
    if (total > ZIP_LIMITS.maxUnpackedBytes) {
      return { ok: false, reason: "The archive unpacks to more than 100 MiB." };
    }
  }
  return { ok: true };
}

/** Checks the bytes against the declared type, the file name's extension and, for zips, the limits. */
export function checkContent(input: {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
  readonly filename: string;
}): ContentCheck {
  const type = (input.contentType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  const rule = TYPES[type];
  if (rule === undefined)
    return { ok: false, reason: `Files of type ${type || "unknown"} are not accepted.` };
  if (input.bytes.length === 0) return { ok: false, reason: "The file is empty." };
  if (!rule.extensions.includes(extensionOf(input.filename))) {
    return { ok: false, reason: `The file name does not end in an extension for ${type}.` };
  }
  const families = sniffFamilies(input.bytes);
  if (!rule.families.some((family) => families.includes(family))) {
    return { ok: false, reason: `The file's content is not ${type}.` };
  }
  if (rule.families.includes("zip")) return checkZip(input.bytes, OFFICE_ZIPS.has(type));
  return { ok: true };
}
