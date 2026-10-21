/**
 * NFC NDEF for the Scan tab (Section 4.3 item 7, Section 13 Scanning: "NFC NDEF"). A tag held to the
 * phone is one more input beside the camera and typed entry: its first text or URI record is the code,
 * and a tag without one (a bare chip or an unformatted sticker) reads as its serial number, in hex.
 * Compass writes asset tags as one NDEF text record, the same shape it reads (Lookup, A92).
 *
 * Everything here is pure: src/runtime/nfc.ts talks to the radio (react-native-nfc-manager) or, in a
 * Maestro test build, to the on-screen test tag.
 */
import { ndefText } from "./scan";

/** TNF 1, NFC Forum well-known type (RTD): text ("T") and URI ("U") records. */
export const TNF_WELL_KNOWN = 1;
const TYPE_TEXT = 0x54;
const TYPE_URI = 0x55;

/** One NDEF record as the native module reports it: type and id as bytes or a string. */
export interface NdefRecordData {
  readonly tnf: number;
  readonly type: readonly number[] | string;
  readonly payload: readonly number[];
  readonly id?: readonly number[] | string;
}

/** A tag as the native module reports it; the serial number is hex, the message is absent when unset. */
export interface NfcTagData {
  readonly id?: string | null;
  readonly ndefMessage?: readonly NdefRecordData[] | null;
}

/** Where the code came from: a text record, a URI record, or the chip's serial number. */
export type NfcCodeSource = "text" | "uri" | "serial";

export interface NfcCode {
  readonly code: string;
  readonly source: NfcCodeSource;
}

/** URI identifier codes of the NFC Forum URI record type, by the payload's first byte. */
const URI_PREFIXES: readonly string[] = [
  "",
  "http://www.",
  "https://www.",
  "http://",
  "https://",
  "tel:",
  "mailto:",
  "ftp://anonymous:anonymous@",
  "ftp://ftp.",
  "ftps://",
  "sftp://",
  "smb://",
  "nfs://",
  "ftp://",
  "dav://",
  "news:",
  "telnet://",
  "imap:",
  "rtsp://",
  "urn:",
  "pop:",
  "sip:",
  "sips:",
  "tftp:",
  "btspp://",
  "btl2cap://",
  "btgoep://",
  "tcpobex://",
  "irdaobex://",
  "file://",
  "urn:epc:id:",
  "urn:epc:tag:",
  "urn:epc:pat:",
  "urn:epc:raw:",
  "urn:epc:",
  "urn:nfc:",
];

function decodeUtf8(bytes: readonly number[]): string {
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

/** Decodes an NDEF URI record payload: the prefix code, then the rest of the URI in UTF-8. */
export function ndefUri(payload: readonly number[]): string | null {
  if (payload.length < 2) return null;
  const prefix = URI_PREFIXES[payload[0] ?? 0] ?? "";
  return `${prefix}${decodeUtf8(payload.slice(1))}`;
}

function recordType(record: NdefRecordData): number | null {
  if (typeof record.type === "string")
    return record.type.length === 1 ? record.type.charCodeAt(0) : null;
  return record.type.length === 1 ? (record.type[0] ?? null) : null;
}

/** The serial number as uppercase hex without separators, or null for a missing or odd value. */
export function tagSerial(id: string | null | undefined): string | null {
  const hex = (id ?? "").replace(/[\s:-]/g, "").toUpperCase();
  return /^[0-9A-F]{4,40}$/.test(hex) ? hex : null;
}

/**
 * The code a tag carries: its first non-empty text or URI record, else its serial number. Null when it
 * carries neither, which the screen reports as a tag it could not read.
 */
export function codeFromTag(tag: NfcTagData | null | undefined): NfcCode | null {
  for (const record of tag?.ndefMessage ?? []) {
    if (record.tnf !== TNF_WELL_KNOWN) continue;
    const type = recordType(record);
    if (type === TYPE_TEXT) {
      const text = ndefText(record.payload)?.trim();
      if (text) return { code: text, source: "text" };
    } else if (type === TYPE_URI) {
      const uri = ndefUri(record.payload)?.trim();
      if (uri) return { code: uri, source: "uri" };
    }
  }
  const serial = tagSerial(tag?.id);
  return serial ? { code: serial, source: "serial" } : null;
}

/** The longest text Compass writes: a short record keeps to the smallest stickers (NTAG213, 137 bytes). */
export const MAX_TAG_TEXT = 100;

/**
 * One NDEF message with a single well-known text record (UTF-8, language "en"), as bytes for the
 * native writer. Throws for empty or overlong text, which never comes from an asset tag.
 */
export function encodeTextMessage(text: string, language = "en"): number[] {
  const value = text.trim();
  if (value.length === 0 || value.length > MAX_TAG_TEXT) {
    throw new Error(`A tag holds 1 to ${MAX_TAG_TEXT} characters; got ${value.length}.`);
  }
  const lang = [...new TextEncoder().encode(language)];
  const body = [...new TextEncoder().encode(value)];
  const payload = [lang.length & 0x3f, ...lang, ...body];
  // MB, ME and SR set, TNF well known: one short record (payload under 256 bytes).
  return [0xd1, 1, payload.length, TYPE_TEXT, ...payload];
}

/** The records of a message Compass encoded, decoded back, for the test tag and the unit tests. */
export function decodeMessage(bytes: readonly number[]): NdefRecordData[] {
  const records: NdefRecordData[] = [];
  let i = 0;
  while (i < bytes.length) {
    const header = bytes[i] ?? 0;
    const short = (header & 0x10) !== 0;
    const hasId = (header & 0x08) !== 0;
    const typeLength = bytes[i + 1] ?? 0;
    let cursor = i + 2;
    let payloadLength: number;
    if (short) {
      payloadLength = bytes[cursor] ?? 0;
      cursor += 1;
    } else {
      payloadLength =
        ((bytes[cursor] ?? 0) << 24) |
        ((bytes[cursor + 1] ?? 0) << 16) |
        ((bytes[cursor + 2] ?? 0) << 8) |
        (bytes[cursor + 3] ?? 0);
      cursor += 4;
    }
    const idLength = hasId ? (bytes[cursor] ?? 0) : 0;
    if (hasId) cursor += 1;
    const type = bytes.slice(cursor, cursor + typeLength);
    cursor += typeLength;
    const id = bytes.slice(cursor, cursor + idLength);
    cursor += idLength;
    const payload = bytes.slice(cursor, cursor + payloadLength);
    cursor += payloadLength;
    records.push({ tnf: header & 0x07, type, payload, ...(hasId ? { id } : {}) });
    if ((header & 0x40) !== 0 || cursor <= i) break;
    i = cursor;
  }
  return records;
}

/** A tag holding one text record, as a test tag or a fixture presents it. */
export function textTag(text: string, serial: string | null = null): NfcTagData {
  return { id: serial, ndefMessage: decodeMessage(encodeTextMessage(text)) };
}
