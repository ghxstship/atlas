import { getMessages, locales } from "@xos/i18n";
import { describe, expect, it, vi } from "vitest";
import { refuseTestOnlySwitches, TEST_ONLY_SWITCHES } from "../app.config";
import {
  codeFromTag,
  decodeMessage,
  encodeTextMessage,
  MAX_TAG_TEXT,
  ndefUri,
  tagSerial,
  textTag,
  TNF_WELL_KNOWN,
} from "../src/domain/nfc";
import { classify, serverSymbology } from "../src/domain/scan";
import {
  deviceNfcReader,
  FakeNfcReader,
  fakeNfcRequested,
  FAKE_SERIAL_PREFIX,
  nfc,
} from "../src/runtime/nfc";

const bytes = (text: string) => [...new TextEncoder().encode(text)];

describe("NFC NDEF (Section 13 Scanning, A92)", () => {
  it("reads the code of a text record, which is what Compass writes", () => {
    const message = encodeTextMessage("XOSCR1:CR-000123");
    // One short well-known record: MB, ME and SR set, type T, language en.
    expect(message.slice(0, 4)).toEqual([0xd1, 1, 3 + 16, 0x54]);
    const tag = { id: "04A2249A3C5E80", ndefMessage: decodeMessage(message) };
    expect(codeFromTag(tag)).toEqual({ code: "XOSCR1:CR-000123", source: "text" });
    // The code classifies as a credential exactly as a scanned QR would.
    expect(classify("XOSCR1:CR-000123", "nfc")).toEqual({
      kind: "credential",
      credentialNumber: "CR-000123",
    });
    expect(serverSymbology("nfc")).toBe("NFC");
  });

  it("reads URI records with their prefix code, and record types sent as strings", () => {
    expect(ndefUri([0x04, ...bytes("gateway.example.com/c/1")])).toBe(
      "https://gateway.example.com/c/1",
    );
    expect(ndefUri([0x00, ...bytes("urn:x")])).toBe("urn:x");
    expect(ndefUri([0x04])).toBeNull();
    const tag = {
      ndefMessage: [{ tnf: TNF_WELL_KNOWN, type: "U", payload: [0x03, ...bytes("x.test/a")] }],
    };
    expect(codeFromTag(tag)).toEqual({ code: "http://x.test/a", source: "uri" });
  });

  it("falls back to the chip's serial number, skipping records it cannot use", () => {
    const tag = {
      id: "04:a2:24:9a",
      ndefMessage: [
        { tnf: 2, type: bytes("text/plain"), payload: bytes("ignored") },
        { tnf: TNF_WELL_KNOWN, type: [0x54], payload: [0x02, 0x65, 0x6e] },
      ],
    };
    expect(codeFromTag(tag)).toEqual({ code: "04A2249A", source: "serial" });
    expect(tagSerial("zz")).toBeNull();
    expect(codeFromTag({ id: null, ndefMessage: null })).toBeNull();
    expect(codeFromTag(null)).toBeNull();
  });

  it("writes a short text record and refuses text a small sticker cannot hold", () => {
    const decoded = decodeMessage(encodeTextMessage(" AT-000042 "))[0];
    expect(decoded?.tnf).toBe(TNF_WELL_KNOWN);
    expect(codeFromTag({ ndefMessage: decoded ? [decoded] : [] })?.code).toBe("AT-000042");
    expect(() => encodeTextMessage("   ")).toThrow();
    expect(() => encodeTextMessage("x".repeat(MAX_TAG_TEXT + 1))).toThrow();
    expect(codeFromTag(textTag("LOT:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f"))?.code).toMatch(/^LOT:/);
  });

  it("decodes long records and record ids", () => {
    const payload = [0x02, 0x65, 0x6e, ...bytes("y".repeat(300))];
    const long = [
      0xc9, // MB, ME, IL, TNF 1; not short
      1,
      0,
      0,
      (payload.length >> 8) & 0xff,
      payload.length & 0xff,
      2,
      0x54,
      0x61,
      0x62,
      ...payload,
    ];
    const [record] = decodeMessage(long);
    expect(record?.id).toEqual([0x61, 0x62]);
    expect(codeFromTag({ ndefMessage: record ? [record] : [] })?.code).toBe("y".repeat(300));
  });
});

describe("the test tag of a Maestro build", () => {
  it("is used only when the build asks for it, and refused in an EAS build", () => {
    expect(fakeNfcRequested({})).toBe(false);
    expect(fakeNfcRequested({ EXPO_PUBLIC_XOS_FAKE_NFC: "true" })).toBe(false);
    expect(fakeNfcRequested({ EXPO_PUBLIC_XOS_FAKE_NFC: "1" })).toBe(true);
    // This test run sets no flag, so the bundle uses the radio.
    expect(nfc.fake).toBe(false);
    expect(TEST_ONLY_SWITCHES).toContain("EXPO_PUBLIC_XOS_FAKE_NFC");
    expect(() =>
      refuseTestOnlySwitches({ EXPO_PUBLIC_XOS_FAKE_NFC: "1", EAS_BUILD: "true" }),
    ).toThrow(/EXPO_PUBLIC_XOS_FAKE_NFC is for local and CI Maestro builds only/);
    expect(() => refuseTestOnlySwitches({ EXPO_PUBLIC_XOS_FAKE_NFC: "1" })).not.toThrow();
  });

  it("waits for the sheet, then reads what it presents", async () => {
    const reader = new FakeNfcReader();
    const seen: unknown[] = [];
    const stop = reader.subscribe(() => seen.push(reader.getSnapshot()));
    expect(await reader.availability()).toBe("ready");
    const read = reader.read("Hold the badge");
    expect(reader.pending).toEqual({ kind: "read", alert: "Hold the badge" });
    reader.present("XOSCR1:CR-000777");
    expect(codeFromTag(await read)).toEqual({ code: "XOSCR1:CR-000777", source: "text" });
    expect(reader.pending).toBeNull();
    const chip = reader.read("Hold the tag");
    reader.present(`${FAKE_SERIAL_PREFIX} 04a2249a`);
    expect(codeFromTag(await chip)).toEqual({ code: "04A2249A", source: "serial" });
    const cancelled = reader.read("Hold the tag");
    reader.cancel();
    expect(await cancelled).toBeNull();
    stop();
    expect(seen.length).toBeGreaterThanOrEqual(6);
  });

  it("writes to a blank test tag and remembers what it wrote", async () => {
    const reader = new FakeNfcReader();
    const write = reader.write(encodeTextMessage("AT-000042"), "Hold a sticker");
    expect(reader.pending).toEqual({ kind: "write", alert: "Hold a sticker", text: "AT-000042" });
    reader.present("");
    expect(await write).toBe(true);
    expect(reader.lastWritten).toBe("AT-000042");
    const again = reader.write(encodeTextMessage("AT-000043"), "Hold a sticker");
    // A new request ends the one before it, as a new system NFC session does.
    const replaced = reader.read("Hold the tag");
    expect(await again).toBe(false);
    reader.cancel();
    expect(await replaced).toBeNull();
    expect(reader.lastWritten).toBe("AT-000042");
  });
});

describe("the radio", () => {
  class UserCancel extends Error {}
  class Timeout extends Error {}
  class SessionInvalidated extends Error {}
  function module(overrides: Record<string, unknown> = {}) {
    const calls: string[] = [];
    const manager = {
      start: vi.fn(async () => void calls.push("start")),
      isSupported: vi.fn(async () => true),
      isEnabled: vi.fn(async () => true),
      requestTechnology: vi.fn(async () => void calls.push("request")),
      getTag: vi.fn(async () => textTag("AT-000042", "04A2")),
      cancelTechnologyRequest: vi.fn(async () => void calls.push("cancel")),
      ndefHandler: { writeNdefMessage: vi.fn(async () => void calls.push("write")) },
      ...overrides,
    };
    const lib = {
      default: manager,
      NfcTech: { Ndef: "Ndef" },
      NfcError: { UserCancel, Timeout, SessionInvalidated },
    };
    return { lib, manager, calls };
  }

  it("reads a tag in one session and always ends it", async () => {
    const { lib, calls } = module();
    const reader = deviceNfcReader(async () => lib as never);
    expect(await reader.availability()).toBe("ready");
    expect(codeFromTag(await reader.read("Hold"))).toEqual({ code: "AT-000042", source: "text" });
    expect(await reader.write(encodeTextMessage("AT-000042"), "Hold")).toBe(true);
    // The radio starts once.
    expect(calls).toEqual(["start", "request", "cancel", "request", "write", "cancel"]);
  });

  it("treats a cancelled sheet as nothing read and reports other failures", async () => {
    const cancelled = module({
      requestTechnology: vi.fn(async () => {
        throw new UserCancel();
      }),
    });
    const reader = deviceNfcReader(async () => cancelled.lib as never);
    expect(await reader.read("Hold")).toBeNull();
    expect(await reader.write([1], "Hold")).toBe(false);
    const broken = module({
      getTag: vi.fn(async () => {
        throw new Error("tag lost");
      }),
    });
    await expect(deviceNfcReader(async () => broken.lib as never).read("Hold")).rejects.toThrow(
      "tag lost",
    );
    expect(broken.calls).toContain("cancel");
  });

  it("says when the radio is off or missing", async () => {
    const off = module({ isEnabled: vi.fn(async () => false) });
    expect(await deviceNfcReader(async () => off.lib as never).availability()).toBe("off");
    const none = module({ isSupported: vi.fn(async () => false) });
    expect(await deviceNfcReader(async () => none.lib as never).availability()).toBe("unsupported");
    const missing = deviceNfcReader(async () => {
      throw new Error("no native module");
    });
    expect(await missing.availability()).toBe("unsupported");
  });
});

describe("NFC copy", () => {
  it.each(locales)("has every NFC message in %s", (locale) => {
    const nfcCopy = (getMessages(locale) as unknown as { compassNfc: Record<string, unknown> })
      .compassNfc;
    for (const mode of ["asset", "receiving", "credential", "lookup", "write"]) {
      expect(typeof (nfcCopy["alert"] as Record<string, unknown>)[mode], mode).toBe("string");
    }
    for (const key of ["read", "off", "unreadable", "failed", "write", "written", "writeFailed"]) {
      expect(typeof nfcCopy[key], key).toBe("string");
    }
  });
});
