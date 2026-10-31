import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  gpsExifSegment,
  locationFromCoords,
  locationFromExif,
  readGpsExif,
  withGpsExif,
} from "../src/domain/exif";

// The native modules processPhoto calls, standing in with node: the "re-encoded" photo is a copy of a fixture JPEG
// with no EXIF, as expo-image-manipulator saves it, and File reads and writes the real file.
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "compass-media-"));
let saved = "";
let resized: unknown = null;

vi.mock("expo-image-manipulator", () => ({
  SaveFormat: { JPEG: "jpeg" },
  ImageManipulator: {
    manipulate: () => ({
      resize: (size: unknown) => {
        resized = size;
      },
      renderAsync: () =>
        Promise.resolve({ saveAsync: () => Promise.resolve({ uri: `file://${saved}` }) }),
    }),
  },
}));
vi.mock("expo-file-system", () => ({
  File: class {
    readonly path: string;
    constructor(uri: string) {
      this.path = uri.replace(/^file:\/\//, "");
    }
    bytes() {
      return Promise.resolve(new Uint8Array(readFileSync(this.path)));
    }
    write(content: Uint8Array) {
      writeFileSync(this.path, content);
    }
  },
}));
const location = {
  granted: false,
  last: null as { coords: { latitude: number; longitude: number; altitude: number | null } } | null,
};
vi.mock("expo-location", () => ({
  getForegroundPermissionsAsync: () => Promise.resolve({ granted: location.granted }),
  getLastKnownPositionAsync: () => Promise.resolve(location.last),
}));

const { processPhoto, photoLocation, wantsExif } = await import("../src/runtime/media");
const { proofPhotoSettings } = await import("../src/domain/proof");

const KEEP = new Map<string, unknown>([["media.keep_photo_location", true]]);
const OFF = new Map<string, unknown>([["media.keep_photo_location", false]]);
// What expo-camera returns on iOS with `exif: true` when the photo was tagged: the GPS dictionary.
const IOS_EXIF = {
  "{GPS}": {
    Latitude: 40.7128,
    LatitudeRef: "N",
    Longitude: 74.006,
    LongitudeRef: "W",
    Altitude: 12.5,
    AltitudeRef: 0,
  },
};

function nextPhoto(name = "photo-plain.jpg"): string {
  saved = join(scratch, `${String(Math.random()).slice(2)}.jpg`);
  copyFileSync(fixture(name), saved);
  return saved;
}

beforeEach(() => {
  location.granted = false;
  location.last = null;
  resized = null;
});

describe("photo location (A140, media.keep_photo_location)", () => {
  it("leaves the resized photo without a location while the org keeps it off, the default", async () => {
    for (const settings of [new Map<string, unknown>(), OFF]) {
      const path = nextPhoto();
      const before = readFileSync(path);
      location.granted = true;
      location.last = { coords: { latitude: 1, longitude: 2, altitude: null } };
      const uri = await processPhoto(`file://${path}`, 4032, 3024, { settings, exif: IOS_EXIF });
      expect(uri).toBe(`file://${path}`);
      expect(resized).toEqual({ width: 2048 });
      expect(readFileSync(path).equals(before)).toBe(true);
      expect(readGpsExif(new Uint8Array(readFileSync(path)))).toBeNull();
      expect(wantsExif(settings)).toBe(false);
    }
    // A caller that passes no settings gets the default too.
    resized = null;
    const path = nextPhoto();
    await processPhoto(`file://${path}`, 800, 600);
    expect(resized).toBeNull();
    expect(readGpsExif(new Uint8Array(readFileSync(path)))).toBeNull();
  });

  it("writes the camera's GPS tags back into the resized photo when the org keeps location", async () => {
    expect(wantsExif(KEEP)).toBe(true);
    const path = nextPhoto();
    await processPhoto(`file://${path}`, 3024, 4032, { settings: KEEP, exif: IOS_EXIF });
    expect(resized).toEqual({ height: 2048 });
    const bytes = new Uint8Array(readFileSync(path));
    const place = readGpsExif(bytes);
    expect(place?.latitude).toBeCloseTo(40.7128, 5);
    expect(place?.longitude).toBeCloseTo(-74.006, 5);
    expect(place?.altitude).toBeCloseTo(12.5, 2);
    // Still a JPEG with its JFIF header first and the image data untouched after the new segment.
    expect([...bytes.subarray(0, 4)]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    const plain = new Uint8Array(readFileSync(fixture("photo-plain.jpg")));
    expect(bytes.length).toBe(plain.length + gpsExifSegment(place ?? IOS_PLACE).length);
    expect(
      Buffer.from(bytes.subarray(bytes.length - 200)).equals(
        Buffer.from(plain.subarray(plain.length - 200)),
      ),
    ).toBe(true);
  });

  it("uses the device's recent position when the camera recorded none, and never asks for permission", async () => {
    location.last = { coords: { latitude: -33.8688, longitude: 151.2093, altitude: null } };
    let path = nextPhoto();
    await processPhoto(`file://${path}`, 1000, 800, { settings: KEEP, exif: {} });
    // No permission yet: the photo goes without a location rather than prompting.
    expect(readGpsExif(new Uint8Array(readFileSync(path)))).toBeNull();

    location.granted = true;
    path = nextPhoto();
    await processPhoto(`file://${path}`, 1000, 800, { settings: KEEP, exif: null });
    const place = readGpsExif(new Uint8Array(readFileSync(path)));
    expect(place?.latitude).toBeCloseTo(-33.8688, 5);
    expect(place?.longitude).toBeCloseTo(151.2093, 5);
    expect(place?.altitude).toBeNull();

    location.last = null;
    expect(await photoLocation({ settings: KEEP })).toBeNull();
  });

  it("replaces EXIF a camera wrote, keeping only the location", async () => {
    const camera = new Uint8Array(readFileSync(fixture("photo-camera-exif.jpg")));
    // The fixture's own GPS tags, written by another encoder, read back.
    const original = readGpsExif(camera);
    expect(original?.latitude).toBeCloseTo(-(33 + 51 / 60 + 54.36 / 3600), 5);
    expect(original?.longitude).toBeCloseTo(151 + 12 / 60 + 36 / 3600, 5);
    expect(original?.altitude).toBeCloseTo(58.5, 2);
    expect(Buffer.from(camera).includes("FixtureCam")).toBe(true);

    const path = nextPhoto("photo-camera-exif.jpg");
    await processPhoto(`file://${path}`, 64, 48, { settings: KEEP, exif: IOS_EXIF });
    const bytes = new Uint8Array(readFileSync(path));
    expect(Buffer.from(bytes).includes("FixtureCam")).toBe(false);
    expect(readGpsExif(bytes)?.latitude).toBeCloseTo(40.7128, 5);
    expect(Buffer.from(bytes).indexOf("Exif\0\0")).toBe(Buffer.from(bytes).lastIndexOf("Exif\0\0"));
  });
});

describe("proof-of-performance photos follow the entitlement's org (A140, 2333)", () => {
  // A sponsor has no membership, so the values Compass resolved for them hold no org rule, whatever it is.
  const SPONSOR = new Map<string, unknown>([["me.sounds", false]]);

  it("keeps the location when the entitlement's org keeps it, though the sponsor resolved no org settings", async () => {
    const settings = proofPhotoSettings(SPONSOR, { id: "ent", keep_photo_location: true });
    expect(wantsExif(settings)).toBe(true);
    expect(settings.get("me.sounds")).toBe(false);
    const path = nextPhoto();
    await processPhoto(`file://${path}`, 4032, 3024, { settings, exif: IOS_EXIF });
    expect(readGpsExif(new Uint8Array(readFileSync(path)))?.latitude).toBeCloseTo(40.7128, 5);
  });

  it("leaves it out when the org keeps it off or the entitlement is not on the device yet", async () => {
    for (const entitlement of [
      { id: "ent", keep_photo_location: false },
      { id: "ent" },
      undefined,
    ]) {
      // Even a person whose own resolved values say keep: the entitlement's org decides.
      const settings = proofPhotoSettings(KEEP, entitlement);
      expect(wantsExif(settings)).toBe(false);
      const path = nextPhoto();
      await processPhoto(`file://${path}`, 4032, 3024, { settings, exif: IOS_EXIF });
      expect(readGpsExif(new Uint8Array(readFileSync(path)))).toBeNull();
    }
  });
});

const IOS_PLACE = { latitude: 40.7128, longitude: -74.006, altitude: 12.5 };

describe("EXIF location parsing", () => {
  it("reads the GPS tags of iOS, Android and the photo picker", () => {
    expect(locationFromExif(IOS_EXIF)).toEqual(IOS_PLACE);
    expect(
      locationFromExif({
        GPSLatitude: "40/1,42/1,4608/100",
        GPSLatitudeRef: "N",
        GPSLongitude: "74/1,0/1,2160/100",
        GPSLongitudeRef: "W",
        GPSAltitude: "25/2",
        GPSAltitudeRef: 1,
      }),
    ).toEqual({
      latitude: 40 + 42 / 60 + 46.08 / 3600,
      longitude: -(74 + 21.6 / 3600),
      altitude: -12.5,
    });
    expect(
      locationFromExif({ GPSLatitude: "51.5", GPSLatitudeRef: "N", GPSLongitude: 0.12 }),
    ).toEqual({ latitude: 51.5, longitude: 0.12, altitude: null });
  });

  it("finds no location in EXIF without one, or with nonsense", () => {
    expect(locationFromExif(null)).toBeNull();
    expect(locationFromExif({ Make: "Phone" })).toBeNull();
    expect(locationFromExif({ GPSLatitude: 120, GPSLongitude: 10 })).toBeNull();
    expect(locationFromExif({ GPSLatitude: "1/0", GPSLongitude: 10 })).toBeNull();
    expect(locationFromExif({ GPSLatitude: "x,1/1", GPSLongitude: 10 })).toBeNull();
    expect(locationFromExif({ GPSLatitude: true, GPSLongitude: 10 })).toBeNull();
    expect(locationFromCoords(null)).toBeNull();
    expect(locationFromCoords({ latitude: 95, longitude: 0 })).toBeNull();
    expect(locationFromCoords({ latitude: 10, longitude: 20, altitude: 3 })).toEqual({
      latitude: 10,
      longitude: 20,
      altitude: 3,
    });
  });

  it("round-trips a location through the segment without rounding seconds up to 60", () => {
    for (const place of [
      IOS_PLACE,
      { latitude: 0, longitude: 0, altitude: null },
      { latitude: 89.99999999, longitude: -179.99999999, altitude: -3.25 },
    ]) {
      const jpeg = withGpsExif(new Uint8Array(readFileSync(fixture("photo-plain.jpg"))), place);
      const read = readGpsExif(jpeg);
      expect(read?.latitude).toBeCloseTo(place.latitude, 5);
      expect(read?.longitude).toBeCloseTo(place.longitude, 5);
      if (place.altitude === null) expect(read?.altitude).toBeNull();
      else expect(read?.altitude).toBeCloseTo(place.altitude, 2);
    }
  });

  it("leaves bytes that are not a JPEG alone and reads nothing from them", () => {
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0);
    expect(withGpsExif(png, IOS_PLACE)).toBe(png);
    expect(readGpsExif(png)).toBeNull();
    // A JPEG whose header runs past its end.
    expect(readGpsExif(Uint8Array.of(0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00))).toBeNull();
    // A JPEG with no EXIF.
    expect(readGpsExif(new Uint8Array(readFileSync(fixture("photo-plain.jpg"))))).toBeNull();
  });

  it("reads little-endian EXIF as cameras often write it", () => {
    const big = gpsExifSegment(IOS_PLACE);
    // Re-encode the TIFF structure little-endian by hand: header, then every 16 and 32 bit field.
    const tiff = big.slice(10);
    const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const out = new DataView(new ArrayBuffer(tiff.byteLength));
    new Uint8Array(out.buffer).set(tiff);
    out.setUint16(0, 0x4949);
    out.setUint16(2, 42, true);
    out.setUint32(4, view.getUint32(4), true);
    const swapIfd = (at: number) => {
      const n = view.getUint16(at);
      out.setUint16(at, n, true);
      for (let i = 0; i < n; i += 1) {
        const e = at + 2 + i * 12;
        const type = view.getUint16(e + 2);
        out.setUint16(e, view.getUint16(e), true);
        out.setUint16(e + 2, type, true);
        out.setUint32(e + 4, view.getUint32(e + 4), true);
        if (type === 4 || type === 5) out.setUint32(e + 8, view.getUint32(e + 8), true);
        if (type === 5) {
          const o = view.getUint32(e + 8);
          for (let k = 0; k < view.getUint32(e + 4) * 2; k += 1)
            out.setUint32(o + k * 4, view.getUint32(o + k * 4), true);
        }
      }
    };
    swapIfd(8);
    swapIfd(view.getUint32(8 + 2 + 8));
    const segment = new Uint8Array(big.length);
    segment.set(big.subarray(0, 10));
    segment.set(new Uint8Array(out.buffer), 10);
    const jpeg = new Uint8Array(4 + segment.length);
    jpeg.set([0xff, 0xd8], 0);
    jpeg.set(segment, 2);
    jpeg.set([0xff, 0xd9], 2 + segment.length);
    expect(readGpsExif(jpeg)?.longitude).toBeCloseTo(-74.006, 5);
  });
});
