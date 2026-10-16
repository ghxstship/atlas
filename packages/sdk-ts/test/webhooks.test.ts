import { describe, expect, it } from "vitest";
import { parseSignatureHeader, signWebhookPayload, verifyWebhookSignature } from "../src/index.ts";

const secret = "whsec_contract_test";
const payload = JSON.stringify({ type: "record.state_changed", data: { id: "r1" } });

describe("webhook signatures", () => {
  it("signs and verifies a delivery", async () => {
    const header = await signWebhookPayload(payload, secret, 1_760_000_000);
    expect(header).toMatch(/^t=1760000000,v1=[0-9a-f]{64}$/);
    await expect(
      verifyWebhookSignature({ payload, header, secret, now: 1_760_000_100 }),
    ).resolves.toEqual({
      valid: true,
      timestamp: 1_760_000_000,
    });
  });

  it("signs with the current time by default", async () => {
    const header = await signWebhookPayload(payload, secret);
    await expect(verifyWebhookSignature({ payload, header, secret })).resolves.toMatchObject({
      valid: true,
    });
  });

  it("rejects a tampered body, a wrong secret, an old timestamp and a malformed header", async () => {
    const header = await signWebhookPayload(payload, secret, 1_760_000_000);
    const now = 1_760_000_000;
    expect(await verifyWebhookSignature({ payload: `${payload} `, header, secret, now })).toEqual({
      valid: false,
      reason: "signature_mismatch",
    });
    expect(await verifyWebhookSignature({ payload, header, secret: "other", now })).toEqual({
      valid: false,
      reason: "signature_mismatch",
    });
    expect(await verifyWebhookSignature({ payload, header, secret, now: now + 301 })).toEqual({
      valid: false,
      reason: "timestamp_out_of_tolerance",
    });
    expect(
      await verifyWebhookSignature({
        payload,
        header,
        secret,
        now: now + 600,
        toleranceSeconds: 900,
      }),
    ).toMatchObject({ valid: true });
    expect(await verifyWebhookSignature({ payload, header: "v1=abc", secret, now })).toEqual({
      valid: false,
      reason: "malformed_header",
    });
  });

  it("accepts any matching v1 signature during secret rotation", async () => {
    const header = await signWebhookPayload(payload, secret, 1_760_000_000);
    const rotated = `${header},v1=${"0".repeat(64)}`;
    expect(
      await verifyWebhookSignature({ payload, header: rotated, secret, now: 1_760_000_000 }),
    ).toMatchObject({ valid: true });
  });

  it("parses headers strictly", () => {
    expect(parseSignatureHeader("t=1,v1=" + "a".repeat(64))).toEqual({
      timestamp: 1,
      signatures: ["a".repeat(64)],
    });
    expect(parseSignatureHeader("t=1")).toBeNull();
    expect(parseSignatureHeader("t=x,v1=" + "a".repeat(64))).toBeNull();
    expect(parseSignatureHeader("t=1,v1=short")).toBeNull();
    expect(parseSignatureHeader("garbage")).toBeNull();
    expect(parseSignatureHeader("t=1,v0=zz,v1=" + "b".repeat(64))).toEqual({
      timestamp: 1,
      signatures: ["b".repeat(64)],
    });
  });
});
