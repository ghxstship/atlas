/**
 * Wallet passes in Compass (Section 11.10 item 14, A65-011 part 4): reading the wallet-pass function's
 * answer. The function itself and its signers are tested in @xos/platform (test/wallet.test.ts).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toBase64, walletLabels, walletOutcome, walletRequest } from "../src/domain/wallet";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("the wallet-pass answer", () => {
  it("hands an Apple pass to PassKit and opens a Google Wallet link", () => {
    const pass = Uint8Array.of(0x50, 0x4b, 0x03, 0x04);
    expect(walletOutcome(200, "application/vnd.apple.pkpass", pass)).toEqual({
      kind: "pass",
      bytes: pass,
    });
    expect(
      walletOutcome(
        200,
        "application/json",
        bytes('{"saveUrl":"https://pay.google.com/gp/v/save/abc.def.ghi"}'),
      ),
    ).toEqual({ kind: "link", url: "https://pay.google.com/gp/v/save/abc.def.ghi" });
  });

  it("explains a wallet that is not set up, a pass that is not theirs, and anything else", () => {
    expect(walletOutcome(503, "application/problem+json", bytes("{}"))).toEqual({
      kind: "refused",
      messageKey: "compass.wallet.notConfigured",
    });
    expect(walletOutcome(404, null, bytes(""))).toMatchObject({
      messageKey: "compass.wallet.notFound",
    });
    expect(walletOutcome(422, null, bytes(""))).toMatchObject({
      messageKey: "compass.wallet.notFound",
    });
    expect(walletOutcome(500, null, bytes(""))).toMatchObject({
      messageKey: "compass.wallet.failed",
    });
    // A link anywhere but Google Wallet is never opened.
    expect(
      walletOutcome(200, "application/json", bytes('{"saveUrl":"https://evil.example/x"}')),
    ).toMatchObject({
      messageKey: "compass.wallet.failed",
    });
    expect(walletOutcome(200, "text/html", bytes("<html>"))).toMatchObject({
      messageKey: "compass.wallet.failed",
    });
  });

  it("asks for the pass by kind, id, wallet and language, and encodes the pass for PassKit", () => {
    const labels = walletLabels((key) => `t(${key})`);
    expect(labels).toMatchObject({
      holder: "t(compass.wallet.holder)",
      validUntil: "t(compass.wallet.validUntil)",
    });
    expect(Object.keys(labels)).toHaveLength(8);
    expect(walletRequest("credential", "c1", "apple", "es-US", labels)).toEqual({
      kind: "credential",
      id: "c1",
      platform: "apple",
      locale: "es-US",
      labels,
    });
    for (const sample of ["", "a", "ab", "abc", "añ/ü"]) {
      expect(toBase64(bytes(sample))).toBe(Buffer.from(sample).toString("base64"));
    }
  });

  it("keeps the Add to Apple Wallet button Apple's own (PassKit), as Apple's guidelines ask", () => {
    const swift = readFileSync(
      new URL("../modules/compass-wallet/ios/CompassWalletModule.swift", import.meta.url),
      "utf8",
    );
    expect(swift).toContain("PKAddPassButton(addPassButtonStyle: .black)");
    expect(swift).toContain("PKAddPassesViewController(pass: pass)");
  });
});
