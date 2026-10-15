/**
 * Field photos (Section 13 Media): compressed to a 2048 px long edge and re-encoded as JPEG, which drops
 * EXIF (including location) from the file. The location of an incident travels in its own columns instead.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

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

/** Uploads a local file to field-media; never overwrites, so a retake is a new object. */
export function fieldMediaUploader(client: SupabaseClient) {
  return async (
    path: string,
    localUri: string,
  ): Promise<{ error: { message: string; statusCode?: string } | null }> => {
    const body = await (await fetch(localUri)).arrayBuffer();
    const { error } = await client.storage
      .from("field-media")
      .upload(path, body, { contentType: "image/jpeg", upsert: false });
    if (!error) return { error: null };
    const statusCode =
      "statusCode" in error
        ? String((error as { statusCode?: string | number }).statusCode)
        : undefined;
    return { error: { message: error.message, ...(statusCode ? { statusCode } : {}) } };
  };
}
