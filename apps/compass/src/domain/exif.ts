/**
 * Photo location in JPEG EXIF (Section 13 Media, A140): Compass resizes a field photo and re-encodes it, which drops
 * the camera's EXIF. When the org keeps photo location (media.keep_photo_location), runtime/media.ts writes the place
 * back with withGpsExif: one APP1 Exif segment holding only the GPS tags (version, latitude, longitude and, when
 * known, altitude), so nothing else the camera recorded travels with the photo.
 *
 * Pure byte work, no image library: the segment is a small big-endian TIFF structure placed before the image data.
 */

/** Where a photo was taken: WGS 84 degrees, altitude in meters above sea level when known. */
export interface PhotoLocation {
  readonly latitude: number;
  readonly longitude: number;
  readonly altitude: number | null;
}

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

const TAG = {
  gpsInfo: 0x8825,
  version: 0x0000,
  latitudeRef: 0x0001,
  latitude: 0x0002,
  longitudeRef: 0x0003,
  longitude: 0x0004,
  altitudeRef: 0x0005,
  altitude: 0x0006,
} as const;

const TYPE = { byte: 1, ascii: 2, long: 4, rational: 5 } as const;

function finite(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** A rational "a/b" as a number. */
function rational(text: string): number | null {
  const [a, b] = text.split("/");
  const num = finite(a);
  const den = b === undefined ? 1 : finite(b);
  return num === null || den === null || den === 0 ? null : num / den;
}

/** Degrees from a decimal number, a decimal string or Android's "d/1,m/1,s/100" rationals. */
function degrees(value: unknown): number | null {
  if (typeof value === "number") return finite(value);
  if (typeof value !== "string") return null;
  if (!value.includes("/") && !value.includes(",")) return finite(value);
  const parts = value.split(",").map((p) => rational(p.trim()));
  if (parts.length === 0 || parts.some((p) => p === null)) return null;
  const [d = 0, m = 0, s = 0] = parts as number[];
  return d + m / 60 + s / 3600;
}

function signed(magnitude: number | null, ref: unknown, negative: string): number | null {
  if (magnitude === null) return null;
  return typeof ref === "string" && ref.toUpperCase().startsWith(negative)
    ? -Math.abs(magnitude)
    : magnitude;
}

function inRange(lat: number | null, lon: number | null): lat is number {
  return lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/**
 * The location in the EXIF a camera or the photo picker returned, or null when it has none. iOS nests the GPS tags
 * in a "{GPS}" dictionary (Latitude, LatitudeRef, ...); Android and the picker give flat GPSLatitude tags.
 */
export function locationFromExif(
  exif: Readonly<Record<string, unknown>> | null | undefined,
): PhotoLocation | null {
  if (!exif) return null;
  const nested = exif["{GPS}"];
  const gps =
    nested !== null && typeof nested === "object" ? (nested as Record<string, unknown>) : null;
  const read = (name: string): unknown => (gps ? gps[name] : exif[`GPS${name}`]);
  const latitude = signed(degrees(read("Latitude")), read("LatitudeRef"), "S");
  const longitude = signed(degrees(read("Longitude")), read("LongitudeRef"), "W");
  if (!inRange(latitude, longitude)) return null;
  const altitudeRaw = read("Altitude");
  const altitude =
    typeof altitudeRaw === "string" ? rational(altitudeRaw) : finite(altitudeRaw ?? NaN);
  const below = finite(read("AltitudeRef")) === 1;
  return {
    latitude,
    longitude: longitude as number,
    altitude: altitude === null ? null : below ? -Math.abs(altitude) : altitude,
  };
}

/** A location from a device position, or null when it is not a place on Earth. */
export function locationFromCoords(
  coords: { latitude: number; longitude: number; altitude?: number | null } | null | undefined,
): PhotoLocation | null {
  if (!coords) return null;
  const latitude = finite(coords.latitude);
  const longitude = finite(coords.longitude);
  if (!inRange(latitude, longitude)) return null;
  return { latitude, longitude: longitude as number, altitude: finite(coords.altitude ?? NaN) };
}

/** Degrees, minutes and seconds as rationals (seconds to 1/10000), never rounding up to 60. */
function dms(value: number): [number, number][] {
  const total = Math.round(Math.abs(value) * 3600 * 10000);
  const d = Math.floor(total / 36_000_000);
  const m = Math.floor((total % 36_000_000) / 600_000);
  const s = total % 600_000;
  return [
    [d, 1],
    [m, 1],
    [s, 10_000],
  ];
}

/** The APP1 Exif segment (marker included) holding only the GPS tags of a location. */
export function gpsExifSegment(location: PhotoLocation): Uint8Array {
  const hasAltitude = location.altitude !== null && Number.isFinite(location.altitude);
  const entries = hasAltitude ? 7 : 5;
  // TIFF offsets count from the "MM" byte order mark.
  const ifd0 = 8;
  const gpsIfd = ifd0 + 2 + 12 + 4;
  const data = gpsIfd + 2 + entries * 12 + 4;
  const tiffLength = data + 24 + 24 + (hasAltitude ? 8 : 0);
  const tiff = new Uint8Array(tiffLength);
  const view = new DataView(tiff.buffer);
  tiff.set([0x4d, 0x4d, 0x00, 0x2a], 0);
  view.setUint32(4, ifd0);

  let at = ifd0;
  const entry = (tag: number, type: number, count: number, write: (offset: number) => void) => {
    view.setUint16(at, tag);
    view.setUint16(at + 2, type);
    view.setUint32(at + 4, count);
    write(at + 8);
    at += 12;
  };
  const rationals = (offset: number, values: readonly [number, number][]) => {
    values.forEach(([num, den], i) => {
      view.setUint32(offset + i * 8, num);
      view.setUint32(offset + i * 8 + 4, den);
    });
  };

  view.setUint16(at, 1);
  at += 2;
  entry(TAG.gpsInfo, TYPE.long, 1, (o) => view.setUint32(o, gpsIfd));
  view.setUint32(at, 0);

  at = gpsIfd;
  view.setUint16(at, entries);
  at += 2;
  const latAt = data;
  const lonAt = data + 24;
  const altAt = data + 48;
  entry(TAG.version, TYPE.byte, 4, (o) => tiff.set([2, 3, 0, 0], o));
  entry(TAG.latitudeRef, TYPE.ascii, 2, (o) =>
    tiff.set([location.latitude < 0 ? 0x53 : 0x4e, 0], o),
  );
  entry(TAG.latitude, TYPE.rational, 3, (o) => view.setUint32(o, latAt));
  entry(TAG.longitudeRef, TYPE.ascii, 2, (o) =>
    tiff.set([location.longitude < 0 ? 0x57 : 0x45, 0], o),
  );
  entry(TAG.longitude, TYPE.rational, 3, (o) => view.setUint32(o, lonAt));
  if (hasAltitude) {
    const altitude = location.altitude as number;
    entry(TAG.altitudeRef, TYPE.byte, 1, (o) => tiff.set([altitude < 0 ? 1 : 0], o));
    entry(TAG.altitude, TYPE.rational, 1, (o) => view.setUint32(o, altAt));
    rationals(altAt, [[Math.round(Math.abs(altitude) * 100), 100]]);
  }
  view.setUint32(at, 0);
  rationals(latAt, dms(location.latitude));
  rationals(lonAt, dms(location.longitude));

  const length = 2 + EXIF_HEADER.length + tiff.length;
  const segment = new Uint8Array(2 + length);
  segment.set([0xff, 0xe1, (length >> 8) & 0xff, length & 0xff], 0);
  segment.set(EXIF_HEADER, 4);
  segment.set(tiff, 4 + EXIF_HEADER.length);
  return segment;
}

interface Segment {
  readonly marker: number;
  readonly start: number;
  readonly end: number;
}

/** The marker segments before the image data (SOS), or null when the bytes are not a JPEG. */
function headerSegments(jpeg: Uint8Array): Segment[] | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  const segments: Segment[] = [];
  let at = 2;
  while (at + 2 <= jpeg.length) {
    if (jpeg[at] !== 0xff) return null;
    const marker = jpeg[at + 1] as number;
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return segments;
    if (at + 4 > jpeg.length) return null;
    const length = ((jpeg[at + 2] as number) << 8) | (jpeg[at + 3] as number);
    if (length < 2 || at + 2 + length > jpeg.length) return null;
    segments.push({ marker, start: at, end: at + 2 + length });
    at += 2 + length;
  }
  return null;
}

function isExif(jpeg: Uint8Array, s: Segment): boolean {
  return s.marker === 0xe1 && EXIF_HEADER.every((b, i) => jpeg[s.start + 4 + i] === b);
}

/**
 * The JPEG with its location written as GPS EXIF. Any Exif segment already there is replaced, so the photo carries
 * the GPS tags and nothing else from EXIF; a JFIF header stays first, as JFIF readers expect. Bytes that are not a
 * JPEG come back unchanged.
 */
export function withGpsExif(jpeg: Uint8Array, location: PhotoLocation): Uint8Array {
  const segments = headerSegments(jpeg);
  if (!segments) return jpeg;
  const first = segments[0];
  const insertAt = first && first.marker === 0xe0 ? first.end : 2;
  const kept: Uint8Array[] = [jpeg.subarray(0, insertAt), gpsExifSegment(location)];
  let at = insertAt;
  for (const s of segments) {
    if (s.start < insertAt) continue;
    if (isExif(jpeg, s)) {
      kept.push(jpeg.subarray(at, s.start));
      at = s.end;
    }
  }
  kept.push(jpeg.subarray(at));
  const out = new Uint8Array(kept.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of kept) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The GPS location written in a JPEG's EXIF, or null when it has none. Reads either byte order. */
export function readGpsExif(jpeg: Uint8Array): PhotoLocation | null {
  const segments = headerSegments(jpeg);
  const exif = segments?.find((s) => isExif(jpeg, s));
  if (!exif) return null;
  const base = exif.start + 4 + EXIF_HEADER.length;
  const view = new DataView(jpeg.buffer, jpeg.byteOffset + base, exif.end - base);
  if (view.byteLength < 8) return null;
  const little = view.getUint16(0) === 0x4949;
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);
  const entries = (ifd: number) => {
    const out = new Map<number, { type: number; count: number; at: number }>();
    if (ifd + 2 > view.byteLength) return out;
    const n = u16(ifd);
    for (let i = 0; i < n && ifd + 2 + i * 12 + 12 <= view.byteLength; i += 1) {
      const at = ifd + 2 + i * 12;
      out.set(u16(at), { type: u16(at + 2), count: u32(at + 4), at: at + 8 });
    }
    return out;
  };
  const gpsPointer = entries(u32(4)).get(TAG.gpsInfo);
  if (!gpsPointer) return null;
  const gps = entries(u32(gpsPointer.at));
  const ratio = (offset: number) => u32(offset) / (u32(offset + 4) || 1);
  const angle = (tag: number) => {
    const e = gps.get(tag);
    if (!e || e.type !== TYPE.rational || e.count !== 3) return null;
    const o = u32(e.at);
    if (o + 24 > view.byteLength) return null;
    return ratio(o) + ratio(o + 8) / 60 + ratio(o + 16) / 3600;
  };
  const ref = (tag: number) => {
    const e = gps.get(tag);
    return e ? String.fromCharCode(view.getUint8(e.at)) : "";
  };
  const latitude = signed(angle(TAG.latitude), ref(TAG.latitudeRef), "S");
  const longitude = signed(angle(TAG.longitude), ref(TAG.longitudeRef), "W");
  if (!inRange(latitude, longitude)) return null;
  const alt = gps.get(TAG.altitude);
  let altitude: number | null = null;
  if (alt && alt.type === TYPE.rational && u32(alt.at) + 8 <= view.byteLength) {
    altitude = ratio(u32(alt.at));
    const below = gps.get(TAG.altitudeRef);
    if (below && view.getUint8(below.at) === 1) altitude = -altitude;
  }
  return { latitude, longitude: longitude as number, altitude };
}
