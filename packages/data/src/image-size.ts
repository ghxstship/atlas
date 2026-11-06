/**
 * The pixel size of a PNG or JPEG read from its header bytes (B1, ADR 0140 D3): a site plan's drawing size is measured
 * by Atlas when the drawing is set, never typed by a person. PNG keeps it in the IHDR chunk; JPEG in its first start of
 * frame marker (SOF0 to SOF15, without DHT, JPG and DAC). A JPEG's EXIF orientation is reported too: a browser draws
 * an image upright by it, a PDF does not, so a drawing whose orientation is not 1 is refused for a rotated export
 * rather than drawn sideways in one of the two. Pure, safe in the browser.
 */

export interface ImageSize {
  readonly type: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  /** EXIF orientation of a JPEG, 1 to 8; 1 when absent and for PNG. */
  readonly orientation: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function imageSize(bytes: Uint8Array): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    // The first chunk is IHDR: length (4), type (4), then width and height (4 each, big-endian).
    if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width > 0 && height > 0 ? { type: "image/png", width, height, orientation: 1 } : null;
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  let orientation = 1;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] as number;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    if (marker === 0xe1) {
      orientation = exifOrientation(bytes.subarray(offset + 4, offset + 2 + length)) ?? orientation;
    }
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (length < 7) return null;
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      return width > 0 && height > 0 ? { type: "image/jpeg", width, height, orientation } : null;
    }
    if (marker === 0xda || marker === 0xd9) return null;
    offset += 2 + length;
  }
  return null;
}

/** The Orientation tag (0x0112) of an APP1 Exif segment's first IFD, or null when there is none. */
function exifOrientation(segment: Uint8Array): number | null {
  if (segment.length < 14 || String.fromCharCode(...segment.subarray(0, 4)) !== "Exif") return null;
  const tiff = segment.subarray(6);
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null;
  const ifd = view.getUint32(4, little);
  if (ifd + 2 > tiff.length) return null;
  const entries = view.getUint16(ifd, little);
  for (let i = 0; i < entries; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return null;
    if (view.getUint16(entry, little) === 0x0112) {
      const value = view.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}
