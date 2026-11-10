/**
 * Field photos (Section 13 Media): compressed to a 2048 px long edge and re-encoded as JPEG, which drops EXIF
 * (including location) from the file. The location of an incident travels in its own columns instead.
 *
 * An org that keeps photo location (media.keep_photo_location, A140; off by default) gets the place written back
 * into the resized file as GPS EXIF (src/domain/exif.ts): the camera's own GPS tags when it recorded them, else the
 * device's last position when Compass already holds location permission. Compass never asks for location only to
 * tag a photo, and nothing else from EXIF is kept.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as Location from "expo-location";
import {
  locationFromCoords,
  locationFromExif,
  withGpsExif,
  type PhotoLocation,
} from "../domain/exif";
import { keepsPhotoLocation, NO_VALUES, type ResolvedValues } from "../domain/settings";
import { decodeBase64 } from "../workforce/writes";

export const LONG_EDGE = 2048;

export function resizeFor(
  width: number,
  height: number,
): { width: number } | { height: number } | null {
  if (Math.max(width, height) <= LONG_EDGE) return null;
  return width >= height ? { width: LONG_EDGE } : { height: LONG_EDGE };
}

/** How a photo was taken: the org's resolved settings and the EXIF the camera returned (with `exif: true`). */
export interface PhotoContext {
  readonly settings: ResolvedValues;
  readonly exif?: Readonly<Record<string, unknown>> | null | undefined;
}

/** A position fix older than this is not where the photo was taken. */
const LAST_POSITION_MAX_AGE_MS = 2 * 60_000;

/** The device's recent position when location permission is already granted, else null; it never prompts. */
async function devicePosition(): Promise<PhotoLocation | null> {
  try {
    const permission = await Location.getForegroundPermissionsAsync();
    if (!permission.granted) return null;
    const last = await Location.getLastKnownPositionAsync({ maxAge: LAST_POSITION_MAX_AGE_MS });
    return locationFromCoords(last?.coords);
  } catch {
    return null;
  }
}

/** Where the photo was taken, when the org keeps photo location: the camera's GPS tags, else the device's position. */
export async function photoLocation(context: PhotoContext): Promise<PhotoLocation | null> {
  if (!keepsPhotoLocation(context.settings)) return null;
  return locationFromExif(context.exif) ?? (await devicePosition());
}

/** Whether the camera should return EXIF for a photo: only to read its GPS tags when the org keeps location. */
export function wantsExif(settings: ResolvedValues): boolean {
  return keepsPhotoLocation(settings);
}

export async function processPhoto(
  uri: string,
  width: number,
  height: number,
  context: PhotoContext = { settings: NO_VALUES },
): Promise<string> {
  const manipulation = ImageManipulator.manipulate(uri);
  const resize = resizeFor(width, height);
  if (resize) manipulation.resize(resize);
  const image = await manipulation.renderAsync();
  const saved = await image.saveAsync({ compress: 0.7, format: SaveFormat.JPEG });
  // media.keep_photo_location off (the default): the re-encoded file leaves without a location.
  const location = await photoLocation(context);
  if (location) {
    const file = new File(saved.uri);
    file.write(withGpsExif(await file.bytes(), location));
  }
  return saved.uri;
}

/** The content type field-media expects for an object name (images, 0368; AAC voice notes, 1113). */
export function contentTypeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".m4a")) return "audio/mp4";
  return lower.endsWith(".png") ? "image/png" : "image/jpeg";
}

/**
 * The bytes of a file on the device, or of a base64 data URI (a drawn signature rendered to PNG in
 * memory), with its content type.
 */
export async function readLocalFile(
  path: string,
  localUri: string,
): Promise<{ body: ArrayBuffer | Uint8Array; contentType: string }> {
  const data = /^data:([^;,]+);base64,(.*)$/.exec(localUri);
  if (data)
    return { body: decodeBase64(data[2] ?? ""), contentType: data[1] ?? contentTypeFor(path) };
  return { body: await (await fetch(localUri)).arrayBuffer(), contentType: contentTypeFor(path) };
}

/** Uploads a local file to field-media; never overwrites, so a retake is a new object. */
export function fieldMediaUploader(client: SupabaseClient) {
  return async (
    path: string,
    localUri: string,
  ): Promise<{ error: { message: string; statusCode?: string } | null }> => {
    const { body, contentType } = await readLocalFile(path, localUri);
    const { error } = await client.storage
      .from("field-media")
      .upload(path, body, { contentType, upsert: false });
    if (!error) return { error: null };
    const raw = (error as { statusCode?: string | number }).statusCode;
    const statusCode = raw === undefined || raw === null ? undefined : String(raw);
    return { error: { message: error.message, ...(statusCode ? { statusCode } : {}) } };
  };
}
