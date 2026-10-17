/**
 * Field photos (Section 13 Media): compressed to a 2048 px long edge and re-encoded as JPEG, which drops
 * EXIF (including location) from the file. The location of an incident travels in its own columns instead.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { decodeBase64 } from "../workforce/writes";

export const LONG_EDGE = 2048;

export function resizeFor(
  width: number,
  height: number,
): { width: number } | { height: number } | null {
  if (Math.max(width, height) <= LONG_EDGE) return null;
  return width >= height ? { width: LONG_EDGE } : { height: LONG_EDGE };
}

export async function processPhoto(uri: string, width: number, height: number): Promise<string> {
  const context = ImageManipulator.manipulate(uri);
  const resize = resizeFor(width, height);
  if (resize) context.resize(resize);
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ compress: 0.7, format: SaveFormat.JPEG });
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
