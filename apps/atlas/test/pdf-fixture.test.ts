import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pdfStreams } from "./fixtures/pdf";

/**
 * The fixture's stream reader. Compressed data ends in a checksum, so about one stream in 256 ends
 * in a carriage return; read up to the "\r\nendstream" delimiter, it loses that byte and no longer
 * inflates, which made the watermark checks fail on the minutes whose stamp compressed that way.
 */
describe("pdfStreams", () => {
  const pdf = (data: Buffer) =>
    Buffer.concat([
      Buffer.from(
        `%PDF-1.4\n1 0 obj\n<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`,
        "latin1",
      ),
      data,
      Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
    ]);

  it("inflates a compressed stream whose data ends in a carriage return", () => {
    let n = 0;
    let data = deflateSync(`BT (Mark ${n}) Tj ET`);
    while (data[data.length - 1] !== 0x0d) data = deflateSync(`BT (Mark ${++n}) Tj ET`);
    expect(pdfStreams(new Uint8Array(pdf(data)))).toContain(`(mark ${n}) tj`);
  });

  it("reads a stream with no direct length up to its delimiter", () => {
    const body =
      "%PDF-1.4\n1 0 obj\n<< /Length 2 0 R >>\nstream\nBT (Plain) Tj ET\nendstream\nendobj\n";
    expect(pdfStreams(new TextEncoder().encode(body))).toBe("bt (plain) tj et");
  });
});
