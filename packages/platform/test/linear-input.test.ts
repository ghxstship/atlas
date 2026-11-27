import { describe, expect, it } from "vitest";
import {
  htmlToText,
  localPartFor,
  parseClamdReply,
  ScannerUnavailableError,
} from "../src/index.ts";
import { firstAngleGroup, withoutTrailingSlashes } from "../src/strings.ts";

/**
 * Text an outside party chooses (an inbound message, a scanner reply, a configured URL) is read in one pass. Each
 * case below took quadratic time under the pattern it replaced (CodeQL js/polynomial-redos); at these sizes that is
 * minutes, so a two-second ceiling tells the two apart on any runner.
 */
const CEILING_MS = 2_000;

function timed<T>(work: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = work();
  return { value, ms: performance.now() - started };
}

describe("withoutTrailingSlashes", () => {
  it("removes every slash at the end and nothing else", () => {
    expect(withoutTrailingSlashes("https://x.test///")).toBe("https://x.test");
    expect(withoutTrailingSlashes("https://x.test/a/b")).toBe("https://x.test/a/b");
    expect(withoutTrailingSlashes("///")).toBe("");
    expect(withoutTrailingSlashes("")).toBe("");
  });

  it("reads a long run of slashes that does not end the text once", () => {
    const { value, ms } = timed(() => withoutTrailingSlashes(`${"/".repeat(400_000)}x`));
    expect(value).toHaveLength(400_001);
    expect(ms).toBeLessThan(CEILING_MS);
  });
});

describe("firstAngleGroup and localPartFor", () => {
  it("returns the first non-empty group, as the pattern did", () => {
    expect(firstAngleGroup("Erin <erin@x.test>")).toBe("erin@x.test");
    expect(firstAngleGroup("<> then <a>")).toBe("a");
    expect(firstAngleGroup("<a<b>")).toBe("a<b");
    expect(firstAngleGroup("no brackets")).toBeNull();
    expect(firstAngleGroup("<never closed")).toBeNull();
    expect(firstAngleGroup("<>")).toBeNull();
  });

  it("reads a recipient made of opening brackets once", () => {
    const hostile = "<".repeat(400_000);
    const { value, ms } = timed(() =>
      localPartFor([hostile, "Inbox <tour@in.xos.test>"], "in.xos.test"),
    );
    expect(value).toBe("tour");
    expect(ms).toBeLessThan(CEILING_MS);
  });
});

describe("htmlToText on hostile mail", () => {
  it("drops an element whose closing tag carries spaces or attributes", () => {
    expect(htmlToText("<p>Hi</p><SCRIPT>steal()</script foo='bar'><p>there</p>")).toBe("Hi\nthere");
    expect(htmlToText("<style>p{}</STYLE ><p>ok</p>")).toBe("ok");
  });

  it("leaves no element behind when one is wrapped around another", () => {
    const text = htmlToText("<p>a</p><scr<script>x()</script>ipt>alert(1)</script><p>b</p>");
    expect(text).not.toMatch(/<\/?script/i);
    expect(text.startsWith("a\n")).toBe(true);
    expect(text.endsWith("b")).toBe(true);
  });

  it("keeps the text around an element that is never closed", () => {
    expect(htmlToText("<p>before</p><script>never closed <p>after</p>")).toBe(
      "before\nnever closed after",
    );
    expect(htmlToText("1 < 2")).toBe("1 < 2");
    expect(htmlToText("empty <> brackets stay")).toBe("empty <> brackets stay");
  });

  it("reads many unclosed elements once", () => {
    const hostile = `${"<script>".repeat(100_000)}<p>kept</p>${"<blockquote".repeat(50_000)}`;
    const { value, ms } = timed(() => htmlToText(hostile));
    expect(value).toContain("kept");
    expect(ms).toBeLessThan(CEILING_MS);
  });

  it("reads many unclosed tags once", () => {
    const { value, ms } = timed(() => htmlToText(`${"<a ".repeat(200_000)}tail`));
    expect(value.endsWith("tail")).toBe(true);
    expect(ms).toBeLessThan(CEILING_MS);
  });
});

describe("parseClamdReply by position", () => {
  it("reads the signature after the first colon that a space follows", () => {
    expect(parseClamdReply("C:\\scan\\file: Win.Test.EICAR_HDB-1 FOUND\0\0")).toEqual({
      clean: false,
      signature: "Win.Test.EICAR_HDB-1",
    });
    expect(parseClamdReply("stream:   Two Words   FOUND")).toEqual({
      clean: false,
      signature: "Two Words",
    });
  });

  it("gives no verdict for a reply that only resembles one", () => {
    for (const reply of [
      "stream: FOUND",
      "stream:x FOUND",
      "FOUND",
      "a: b\nc FOUND",
      "stream: xFOUND",
    ]) {
      expect(() => parseClamdReply(reply), reply).toThrow(ScannerUnavailableError);
    }
  });

  it("reads a long reply once", () => {
    const { ms } = timed(() => {
      expect(() => parseClamdReply(`: ${" ".repeat(300_000)}x`)).toThrow(ScannerUnavailableError);
      expect(() => parseClamdReply(`${"\0".repeat(300_000)}x`)).toThrow(ScannerUnavailableError);
    });
    expect(ms).toBeLessThan(CEILING_MS);
  });
});
