/**
 * The little ASN.1 DER the Apple Wallet signature needs (A93, RRR-138): encoding the CMS SignedData of a
 * pass's manifest and reading a certificate's issuer and serial number. Web Crypto signs; this only lays
 * the bytes out, so the Edge runtime needs no crypto library.
 */

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function lengthBytes(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

/** One tag-length-value element. */
export function tlv(tag: number, ...content: readonly Uint8Array[]): Uint8Array {
  const body = concat(...content);
  return concat(Uint8Array.of(tag), lengthBytes(body.length), body);
}

export const sequence = (...content: readonly Uint8Array[]): Uint8Array => tlv(0x30, ...content);

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** A SET OF, its elements in DER's ascending order of their encodings. */
export function setOf(...elements: readonly Uint8Array[]): Uint8Array {
  return tlv(0x31, ...[...elements].sort(compareBytes));
}

/** A context-specific constructed element, [n]. */
export function context(n: number, ...content: readonly Uint8Array[]): Uint8Array {
  return tlv(0xa0 | n, ...content);
}

export const NULL = Uint8Array.of(0x05, 0x00);

export function oid(dotted: string): Uint8Array {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes: number[] = [first * 40 + second];
  for (const arc of rest) {
    const chunk: number[] = [];
    let n = arc;
    do {
      chunk.unshift(n % 128);
      n = Math.floor(n / 128);
    } while (n > 0);
    for (let i = 0; i < chunk.length - 1; i += 1) chunk[i] = (chunk[i] ?? 0) | 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(bytes));
}

export function integer(value: number | Uint8Array): Uint8Array {
  let bytes: Uint8Array;
  if (typeof value === "number") {
    const out: number[] = [];
    let n = value;
    do {
      out.unshift(n % 256);
      n = Math.floor(n / 256);
    } while (n > 0);
    bytes = Uint8Array.from(out);
  } else bytes = value;
  // A positive integer whose first bit is set takes a leading zero.
  if ((bytes[0] ?? 0) & 0x80) bytes = concat(Uint8Array.of(0), bytes);
  return tlv(0x02, bytes);
}

export const octetString = (bytes: Uint8Array): Uint8Array => tlv(0x04, bytes);

/** UTCTime, YYMMDDHHMMSSZ (CMS signing time before 2050). */
export function utcTime(date: Date): Uint8Array {
  const pad = (n: number) => String(n).padStart(2, "0");
  const text =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z";
  return tlv(0x17, new TextEncoder().encode(text));
}

export interface Element {
  readonly tag: number;
  /** Offset of the tag. */
  readonly start: number;
  /** Offset of the content. */
  readonly contentStart: number;
  /** Offset after the element. */
  readonly end: number;
}

/** Reads the element at an offset. */
export function readElement(bytes: Uint8Array, start: number): Element {
  const tag = bytes[start];
  const first = bytes[start + 1];
  if (tag === undefined || first === undefined) throw new Error("DER: truncated element");
  let length = first;
  let contentStart = start + 2;
  if (first & 0x80) {
    const count = first & 0x7f;
    length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + (bytes[start + 2 + i] ?? 0);
    contentStart += count;
  }
  const end = contentStart + length;
  if (end > bytes.length) throw new Error("DER: element runs past the end");
  return { tag, start, contentStart, end };
}

/** The child elements of a constructed element. */
export function children(bytes: Uint8Array, parent: Element): Element[] {
  const out: Element[] = [];
  for (let at = parent.contentStart; at < parent.end;) {
    const child = readElement(bytes, at);
    out.push(child);
    at = child.end;
  }
  return out;
}

export const raw = (bytes: Uint8Array, e: Element): Uint8Array => bytes.subarray(e.start, e.end);

/** A certificate's issuer Name and serialNumber, as encoded, for a CMS IssuerAndSerialNumber. */
export function issuerAndSerial(certificate: Uint8Array): {
  issuer: Uint8Array;
  serial: Uint8Array;
} {
  const cert = readElement(certificate, 0);
  const [tbs] = children(certificate, cert);
  if (!tbs) throw new Error("DER: not a certificate");
  const fields = children(certificate, tbs);
  // An explicit version [0] comes first in a v3 certificate.
  const offset = fields[0]?.tag === 0xa0 ? 1 : 0;
  const serial = fields[offset];
  const issuer = fields[offset + 2];
  if (!serial || serial.tag !== 0x02 || !issuer || issuer.tag !== 0x30)
    throw new Error("DER: not a certificate");
  return { issuer: raw(certificate, issuer), serial: raw(certificate, serial) };
}

/** The DER bytes of a PEM block (certificate or key). */
export function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  if (!body) throw new Error("PEM: empty");
  const text = atob(body);
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

const RSA_ENCRYPTION = "1.2.840.113549.1.1.1";

/**
 * A private key as PKCS#8 for Web Crypto: PKCS#8 PEM as it is, a PKCS#1 ("BEGIN RSA PRIVATE KEY") key
 * wrapped in a PrivateKeyInfo.
 */
export function pkcs8Of(pem: string): Uint8Array {
  const der = pemToDer(pem);
  if (!pem.includes("BEGIN RSA PRIVATE KEY")) return der;
  return sequence(integer(0), sequence(oid(RSA_ENCRYPTION), NULL), octetString(der));
}
