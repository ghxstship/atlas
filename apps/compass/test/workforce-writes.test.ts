import { describe, expect, it } from "vitest";
import { buildShiftAction, claimConflict, type ShiftRow } from "../src/domain/shifts";
import {
  crc32,
  encodePng,
  parseStrokes,
  rasterize,
  signaturePng,
} from "../src/workforce/signature-png";
import {
  WORKFORCE_SYNC_RPCS,
  buildFormSubmission,
  decodeBase64,
  encodeBase64,
  formMediaPath,
  workforceWrite,
} from "../src/workforce/writes";

const ORG = "0192f1e2-7c3a-7b4d-9e8f-000000000001";
const PERSON = "0192f1e2-7c3a-7b4d-9e8f-000000000002";

describe("workforce writes", () => {
  it("queues the sixteen allowlisted RPCs through apply_sync_mutation", () => {
    expect(WORKFORCE_SYNC_RPCS).toHaveLength(16);
    const m = workforceWrite(
      "acknowledge_feed_post",
      { p_post_id: "p1", p_extra: undefined },
      0,
      () => "w1",
    );
    expect(m).toEqual({
      op: "rpc",
      target: "app.acknowledge_feed_post",
      table: "feed_acknowledgments",
      rowId: "w1",
      payload: { p_post_id: "p1" },
      policy: "append",
      optimistic: null,
    });
  });

  it("journey 65: a form filled offline queues one submit_form with its photo and signature", () => {
    const photo = formMediaPath(ORG, PERSON, "ph-1.jpg");
    const m = buildFormSubmission(
      {
        orgId: ORG,
        personId: PERSON,
        templateId: "tpl-1",
        answers: { hazard: true, notes: "Rail loose at gate B", photo: [photo] },
        projectId: "prj-1",
        location: { latitude: 25.77, longitude: -80.19, accuracyM: 8 },
        signature: { signerName: "Dana Reyes", svgPath: "M10 10L60 40L120 12" },
        photos: [{ storagePath: photo, localUri: "file:///ph-1.jpg" }],
      },
      0,
      () => "sub-1",
    );
    expect(m.target).toBe("app.submit_form");
    expect(m.payload).toMatchObject({
      p_template_id: "tpl-1",
      p_project_id: "prj-1",
      p_location: { latitude: 25.77, longitude: -80.19, accuracy_m: 8 },
      p_signature: {
        signer_name: "Dana Reyes",
        signature_path: `${ORG}/forms/${PERSON}/sub-1-signature.png`,
      },
    });
    const media = m.payload["device_media"] as { storage_path: string; local_uri: string }[];
    expect(media.map((f) => f.storage_path)).toEqual([
      photo,
      `${ORG}/forms/${PERSON}/sub-1-signature.png`,
    ]);
    expect(media[1]?.local_uri.startsWith("data:image/png;base64,")).toBe(true);
    // The object names fit the 0808 storage policy: <org_id>/forms/<person_id>/<file>.
    for (const f of media) expect(f.storage_path.split("/")).toHaveLength(4);
  });

  it("leaves the signature and location out when the form needs neither", () => {
    const m = buildFormSubmission(
      {
        orgId: ORG,
        personId: PERSON,
        templateId: "tpl-2",
        answers: { ok: true },
        projectId: null,
        location: null,
        signature: null,
        photos: [],
      },
      0,
    );
    expect(Object.keys(m.payload).sort()).toEqual(["p_answers", "p_template_id"]);
  });

  it("round-trips base64 without platform globals", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253]);
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
    expect(encodeBase64(new TextEncoder().encode("Ma"))).toBe("TWE=");
  });
});

describe("signature PNG", () => {
  it("reads the SignaturePad's strokes", () => {
    expect(parseStrokes("M1.0 2.0L3.0 4.0M5 6L7 8L9 10")).toEqual([
      [
        [1, 2],
        [3, 4],
      ],
      [
        [5, 6],
        [7, 8],
        [9, 10],
      ],
    ]);
  });

  it("inks the strokes and leaves a blank pad white", () => {
    expect(rasterize("").every((p) => p === 255)).toBe(true);
    const inked = rasterize("M0 0L100 50");
    expect(inked.some((p) => p === 0)).toBe(true);
  });

  it("writes a valid PNG: signature, header and checksummed chunks", () => {
    const png = signaturePng("M0 0L100 50");
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer);
    expect(view.getUint32(16)).toBe(600);
    expect(view.getUint32(20)).toBe(200);
    const ihdr = png.subarray(12, 12 + 4 + 13);
    expect(view.getUint32(12 + 4 + 13)).toBe(crc32(ihdr));
    const tiny = encodePng(new Uint8Array([0, 255]), 2, 1);
    expect(String.fromCharCode(...tiny.subarray(tiny.length - 8, tiny.length - 4))).toBe("IEND");
  });
});

describe("journey 66: claiming open shifts", () => {
  const shift = (
    id: string,
    start: string,
    end: string,
    extra: Partial<ShiftRow> = {},
  ): ShiftRow => ({
    id,
    project_id: "p1",
    starts_at: start,
    ends_at: end,
    shift_state: "Published",
    membership_id: null,
    ...extra,
  });

  it("refuses on the device a claim that overlaps a shift the person holds", () => {
    const open = shift("o1", "2027-06-01T12:00:00Z", "2027-06-01T20:00:00Z");
    const held = shift("m1", "2027-06-01T18:00:00Z", "2027-06-01T23:00:00Z", {
      membership_id: "me",
      shift_state: "Accepted",
    });
    expect(claimConflict(open, [held])?.id).toBe("m1");
    expect(claimConflict(open, [{ ...held, shift_state: "Canceled" }])).toBeNull();
    expect(claimConflict(open, [{ ...held, starts_at: "2027-06-01T20:00:00Z" }])).toBeNull();
  });

  it("claims through app.claim_open_shift and moves the shift to the person while queued", () => {
    const open = shift("o1", "2027-06-01T12:00:00Z", "2027-06-01T20:00:00Z");
    const m = buildShiftAction(open, "claim", false, "me");
    expect(m).toMatchObject({
      op: "rpc",
      target: "app.claim_open_shift",
      payload: { p_shift_id: "o1" },
      policy: "cas",
      optimistic: { membership_id: "me", shift_state: "Accepted" },
    });
  });
});
