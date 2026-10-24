/**
 * Receipt photos (A92, Section 4.3 item 11). A receipt comes from Compass's camera or from one photo the person picks
 * in the system photo picker, which needs no photo library permission. Either way it is compressed to a 2048 px long
 * edge and re-encoded as JPEG (Section 13 Media), which drops EXIF and its location, and kept as base64 for Aurora.
 */
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { resizeFor } from "./media";

export interface ReceiptImage {
  /** The compressed JPEG on the device, uploaded with the expense. */
  readonly uri: string;
  /** The same JPEG as base64, sent to Aurora when the org has document extraction on. */
  readonly base64: string;
}

export async function processReceipt(
  uri: string,
  width: number,
  height: number,
): Promise<ReceiptImage> {
  const context = ImageManipulator.manipulate(uri);
  const resize = resizeFor(width, height);
  if (resize) context.resize(resize);
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ compress: 0.7, format: SaveFormat.JPEG, base64: true });
  return { uri: saved.uri, base64: saved.base64 ?? "" };
}

/** One photo from the system picker, or null when the person closes it. */
export async function pickReceiptPhoto(): Promise<{
  uri: string;
  width: number;
  height: number;
} | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: false,
    allowsMultipleSelection: false,
    exif: false,
    quality: 1,
  });
  const asset = result.canceled ? null : (result.assets[0] ?? null);
  return asset ? { uri: asset.uri, width: asset.width, height: asset.height } : null;
}
