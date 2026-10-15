import { describe, expect, it } from "vitest";
import {
  buildAccessScan,
  buildAssetScan,
  buildIntake,
  classify,
  ContinuousScan,
  custodyAllowed,
  decideGate,
  gtin14,
  ndefText,
  parseGs1,
  serverSymbology,
  SUPPORTED_CAMERA_TYPES,
  symbologyOf,
  validGtin,
  type AccessGridRow,
  type CredentialRow,
} from "../src/domain/scan";

const GS = String.fromCharCode(29);

describe("GTIN validation on device", () => {
  it("accepts valid EAN-13, UPC-A, EAN-8 and GTIN-14 check digits", () => {
    for (const code of ["4006381333931", "036000291452", "95012346", "10614141000415"]) {
      expect(validGtin(code), code).toBe(true);
    }
  });

  it("rejects a wrong check digit or a wrong length", () => {
    expect(validGtin("4006381333932")).toBe(false);
    expect(validGtin("12345")).toBe(false);
    expect(validGtin("40063813339a1")).toBe(false);
  });

  it("normalizes to 14 digits", () => {
    expect(gtin14("036000291452")).toBe("00036000291452");
  });
});

describe("GS1 element strings", () => {
  it("parses raw GS1-128 with FNC1 separators", () => {
    expect(parseGs1(`]C10109501101530003${"17"}261231${"10"}ABC123${GS}21SN-9`)).toEqual({
      gtin: "09501101530003",
      expiry: "261231",
      batch: "ABC123",
      serial: "SN-9",
      other: {},
    });
  });

  it("parses the bracketed human-readable form", () => {
    expect(parseGs1("(01)09501101530003(21)XYZ(400)PO-77")).toEqual({
      gtin: "09501101530003",
      serial: "XYZ",
      other: { "400": "PO-77" },
    });
  });

  it("returns null for strings that are not GS1", () => {
    expect(parseGs1("hello")).toBeNull();
    expect(parseGs1("")).toBeNull();
  });
});

describe("classifying scans", () => {
  it("maps camera types and lists the supported formats", () => {
    expect(symbologyOf("ean13")).toBe("ean13");
    expect(symbologyOf("upc_e")).toBe("upc_a");
    expect(symbologyOf("pdf417")).toBeNull();
    expect(SUPPORTED_CAMERA_TYPES).toEqual([
      "ean13",
      "upc_a",
      "upc_e",
      "ean8",
      "itf14",
      "code128",
      "qr",
      "datamatrix",
    ]);
  });

  it("reads retail and case barcodes as GTINs and refuses bad checksums", () => {
    expect(classify("036000291452", "upc_a")).toEqual({ kind: "gtin", gtin14: "00036000291452" });
    expect(classify("10614141000415", "itf14")).toEqual({ kind: "gtin", gtin14: "10614141000415" });
    expect(classify("4006381333932", "ean13")).toEqual({ kind: "invalid", reason: "checksum" });
  });

  it("reads GS1-128 and Data Matrix GTINs with serials", () => {
    expect(classify(`]d20109501101530003${GS}21SN-1`, "datamatrix")).toEqual({
      kind: "gtin",
      gtin14: "09501101530003",
      serial: "SN-1",
    });
    expect(classify("(01)09501101530003(10)B7", "gs1_128")).toEqual({
      kind: "gtin",
      gtin14: "09501101530003",
      batch: "B7",
    });
    expect(classify("(01)09501101530004", "code128")).toEqual({
      kind: "invalid",
      reason: "checksum",
    });
  });

  it("reads credentials, lots and plain codes", () => {
    expect(classify("CR-000123", "qr")).toEqual({
      kind: "credential",
      credentialNumber: "CR-000123",
    });
    expect(classify("XOSCR1:CR-000124", "qr")).toEqual({
      kind: "credential",
      credentialNumber: "CR-000124",
    });
    expect(classify("LOT:0192AAAA-0000-7000-8000-000000000001", "qr")).toEqual({
      kind: "lot",
      lotId: "0192aaaa-0000-7000-8000-000000000001",
    });
    expect(classify(" AUD-0042 ", "code128")).toEqual({ kind: "code", value: "AUD-0042" });
    expect(classify("tag-1", "nfc")).toEqual({ kind: "code", value: "tag-1" });
  });

  it("refuses empty and unsupported input", () => {
    expect(classify("  ", "qr")).toEqual({ kind: "invalid", reason: "empty" });
    expect(classify("x", null)).toEqual({ kind: "invalid", reason: "unsupported" });
  });

  it("decodes NFC NDEF text records", () => {
    const payload = [
      0x02,
      ...Array.from("en", (c) => c.charCodeAt(0)),
      ...Array.from("AUD-0042", (c) => c.charCodeAt(0)),
    ];
    expect(ndefText(payload)).toBe("AUD-0042");
    expect(ndefText([])).toBeNull();
    expect(ndefText([0x02, 0x65, 0x6e])).toBeNull();
  });
});

describe("gate decisions", () => {
  const now = Date.UTC(2026, 9, 14, 18, 0, 0);
  const cred = (over: Partial<CredentialRow> = {}): CredentialRow => ({
    id: "c1",
    credential_number: "CR-000001",
    credential_category_id: "cat-crew",
    holder_person_id: "p1",
    valid_from: "2026-10-01T00:00:00Z",
    valid_to: null,
    revoked_at: null,
    ...over,
  });
  const grid: AccessGridRow[] = [
    {
      credential_category_id: "cat-crew",
      zone_id: "backstage",
      window_starts_at: "2026-10-14T12:00:00Z",
      window_ends_at: "2026-10-15T02:00:00Z",
    },
    {
      credential_category_id: "cat-crew",
      zone_id: "stage",
      window_starts_at: "2026-10-14T20:00:00Z",
      window_ends_at: "2026-10-14T23:00:00Z",
    },
    {
      credential_category_id: "cat-crew",
      zone_id: "vip",
      window_starts_at: "2026-10-14T12:00:00Z",
      window_ends_at: "2026-10-15T02:00:00Z",
      deleted_at: "2026-10-13T00:00:00Z",
    },
  ];

  it("grants inside the window for the category's zone", () => {
    expect(decideGate("CR-000001", "backstage", [cred()], grid, now).result).toBe("Granted");
  });

  it("denies with a reason the gate staff can act on", () => {
    expect(decideGate("CR-999999", "backstage", [cred()], grid, now)).toEqual({
      result: "Denied",
      reason: "unknown",
      credential: null,
    });
    expect(
      decideGate(
        "CR-000001",
        "backstage",
        [cred({ revoked_at: "2026-10-14T00:00:00Z" })],
        grid,
        now,
      ),
    ).toMatchObject({ reason: "revoked" });
    expect(
      decideGate(
        "CR-000001",
        "backstage",
        [cred({ valid_from: "2026-10-20T00:00:00Z" })],
        grid,
        now,
      ),
    ).toMatchObject({ reason: "not-yet-valid" });
    expect(
      decideGate("CR-000001", "backstage", [cred({ valid_to: "2026-10-14T17:00:00Z" })], grid, now),
    ).toMatchObject({ reason: "expired" });
    expect(decideGate("CR-000001", "stage", [cred()], grid, now)).toMatchObject({
      reason: "outside-window",
    });
    expect(decideGate("CR-000001", "vip", [cred()], grid, now)).toMatchObject({
      reason: "no-zone-access",
    });
  });

  it("queues the scan with the device time and the device's decision", () => {
    const decision = decideGate("CR-000001", "backstage", [cred()], grid, now);
    const m = buildAccessScan(
      cred(),
      "backstage",
      decision,
      "2026-10-14T18:00:00.000Z",
      now,
      () => "s1",
    );
    expect(m).toMatchObject({
      op: "rpc",
      target: "record_scan",
      table: "access_scans",
      rowId: "s1",
      policy: "append",
    });
    expect(m.payload).toEqual({
      p_zone_id: "backstage",
      p_credential_id: "c1",
      p_id: "s1",
      p_device_scanned_at: "2026-10-14T18:00:00.000Z",
      p_offline_result: "Granted",
    });
    expect(m.optimistic).toMatchObject({ id: "s1", offline_result: "Granted" });
    expect(typeof buildAccessScan(cred(), "z", decision, "", now).rowId).toBe("string");
  });
});

describe("continuous receiving", () => {
  it("counts each unit once, ignores frame repeats and supports review", () => {
    const batch = new ContinuousScan(1_000);
    expect(batch.add("A", "code128", 0)).toBe(true);
    expect(batch.add("A", "code128", 300)).toBe(false);
    expect(batch.add("A", "code128", 900)).toBe(false);
    expect(batch.add("B", "code128", 1_000)).toBe(true);
    expect(batch.add("A", "code128", 1_200)).toBe(true);
    expect(batch.total).toBe(3);
    expect(batch.items()).toEqual([
      { code: "A", symbology: "code128", count: 2, firstAt: 0 },
      { code: "B", symbology: "code128", count: 1, firstAt: 1_000 },
    ]);
    batch.decrement("A");
    batch.decrement("B");
    batch.decrement("missing");
    expect(batch.total).toBe(1);
    expect(batch.items().map((i) => i.code)).toEqual(["A"]);
  });

  it("receives 30 items well inside a minute of scanning time", () => {
    const batch = new ContinuousScan();
    for (let i = 0; i < 30; i += 1) batch.add(`CASE-${i}`, "code128", i * 1_800);
    expect(batch.total).toBe(30);
    expect(new ContinuousScan().total).toBe(0);
  });
});

describe("intake and custody", () => {
  it("queues an unknown code for a person to resolve", () => {
    const m = buildIntake(
      "ZZ-UNKNOWN",
      "code128",
      { orgId: "o1", projectId: "p1", mode: "asset", deviceAt: "2026-10-14T18:00:00Z" },
      0,
      () => "i1",
    );
    expect(m?.payload).toEqual({
      id: "i1",
      org_id: "o1",
      project_id: "p1",
      scanned_value: "ZZ-UNKNOWN",
      symbology: "Code 128",
      scan_mode: "Asset",
      device_scanned_at: "2026-10-14T18:00:00Z",
    });
    const receiving = buildIntake(
      "x",
      "qr",
      { orgId: "o", projectId: "p", mode: "receiving", deviceAt: "" },
      0,
    );
    expect(receiving?.payload).toMatchObject({ symbology: "QR Code", scan_mode: "Shipment" });
    expect(
      buildIntake(
        "10614141000415",
        "itf14",
        { orgId: "o", projectId: "p", mode: "asset", deviceAt: "" },
        0,
      ),
    ).toBeNull();
    expect(serverSymbology("nfc")).toBe("NFC");
  });

  it("queues a custody scan keyed by its event id", () => {
    const m = buildAssetScan(
      { orgId: "o1", code: "AUD-0042", action: "check-out", custodianMembershipId: "m1" },
      0,
      () => "ev1",
    );
    expect(m).toMatchObject({
      op: "rpc",
      target: "apply_asset_scan_event",
      rowId: "ev1",
      policy: "append",
    });
    expect(m.payload).toMatchObject({ eventId: "ev1", code: "AUD-0042", action: "check-out" });
    expect(buildAssetScan({ orgId: "o", code: "c", action: "check-in" }, 0).rowId).toMatch(/-7/);
  });

  it("limits crew to gear assigned to them", () => {
    const me = { membershipId: null, engagementIds: ["e1"] };
    expect(custodyAllowed("all", null, me)).toBe(true);
    expect(custodyAllowed("assigned", null, me)).toBe(false);
    expect(custodyAllowed("assigned", { membershipId: null, engagementId: "e1" }, me)).toBe(true);
    expect(custodyAllowed("assigned", { membershipId: null, engagementId: "e2" }, me)).toBe(false);
    expect(
      custodyAllowed(
        "assigned",
        { membershipId: "m1", engagementId: null },
        { membershipId: "m1", engagementIds: [] },
      ),
    ).toBe(true);
  });
});
