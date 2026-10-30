import { describe, expect, it } from "vitest";
import { imageSize } from "../src/image-size.ts";
import { DRAWING_WIDE } from "./documents/fixtures.ts";

const hex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], (b) => parseInt(b, 16));

/** A 5 by 3 JPEG header: SOI, an Exif APP1 with Orientation, SOF0, EOI. */
const JPEG_UPRIGHT = hex(
  "ffd8ffe1002245786966000049492a0008000000010012010300010000000100000000000000ffc0000b080003000501011100ffd9",
);
/** The same with Orientation 6 (turned 90 degrees by the camera), big-endian Exif. */
const JPEG_ROTATED = hex(
  "ffd8ffe100224578696600004d4d002a00000008000101120003000000010006000000000000ffc0000b080003000501011100ffd9",
);
const JPEG_PLAIN = hex("ffd8ffc0000b080003000501011100ffd9");

describe("imageSize (ADR 0140 D3)", () => {
  it("reads a PNG's size from its IHDR", () => {
    expect(imageSize(DRAWING_WIDE)).toEqual({
      type: "image/png",
      width: 8,
      height: 4,
      orientation: 1,
    });
  });

  it("reads a JPEG's size from its first frame and its EXIF orientation", () => {
    expect(imageSize(JPEG_PLAIN)).toEqual({
      type: "image/jpeg",
      width: 5,
      height: 3,
      orientation: 1,
    });
    expect(imageSize(JPEG_UPRIGHT)?.orientation).toBe(1);
    expect(imageSize(JPEG_ROTATED)).toEqual({
      type: "image/jpeg",
      width: 5,
      height: 3,
      orientation: 6,
    });
  });

  it("answers null for anything else", () => {
    expect(imageSize(new TextEncoder().encode("%PDF-1.7"))).toBeNull();
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull();
    expect(imageSize(DRAWING_WIDE.subarray(0, 20))).toBeNull();
  });
});
