import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkPinAgainstTag, checkPinFormat, distinctPins, findUses } from "../src/action-pins.ts";

const CHECKOUT = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const WORKFLOW = `
jobs:
  a:
    steps:
      - uses: actions/checkout@${CHECKOUT} # v7.0.1
      - uses: "pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413" # v6.1.0
        with: { x: 1 }
      - name: tagged
        uses: actions/setup-node@v7
      - uses: github/codeql-action/init@${"a".repeat(40)}
      - uses: ./local-action
      - uses: docker://alpine:3.20
      - uses: docker://alpine@sha256:${"b".repeat(64)}
      - run: echo "uses: not/an-action@v1"
`;

describe("findUses", () => {
  it("finds every uses: line with its repository, ref and version comment", () => {
    const uses = findUses("ci.yml", WORKFLOW);
    expect(uses.map((u) => [u.line, u.repository, u.ref, u.version])).toEqual([
      [5, "actions/checkout", CHECKOUT, "v7.0.1"],
      [6, "pnpm/action-setup", "ea17c68df8912ef543352723c149a84f56e3d413", "v6.1.0"],
      [9, "actions/setup-node", "v7", null],
      [10, "github/codeql-action", "a".repeat(40), null],
      [11, "./local-action", "", null],
      [12, "docker://alpine:3.20", "", null],
      [13, "docker://alpine", `sha256:${"b".repeat(64)}`, null],
    ]);
  });
});

describe("checkPinFormat", () => {
  it("needs a full SHA and a version comment, and a digest on container actions", () => {
    const messages = findUses("ci.yml", WORKFLOW).map((u) => checkPinFormat(u)?.message ?? null);
    expect(messages).toEqual([
      null,
      null,
      "actions/setup-node@v7 is not pinned to a full commit SHA",
      `github/codeql-action/init@${"a".repeat(40)} has no "# vX.Y.Z" version comment`,
      null,
      "docker://alpine:3.20 is a container action without an @sha256: digest",
      null,
    ]);
  });
});

describe("checkPinAgainstTag", () => {
  const [use] = findUses("ci.yml", WORKFLOW);
  if (use === undefined) throw new Error("fixture");

  it("accepts a lightweight tag that points at the pinned commit", () => {
    expect(checkPinAgainstTag(use, `${CHECKOUT}\trefs/tags/v7.0.1\n`)).toBeNull();
  });

  it("uses the peeled commit of an annotated tag", () => {
    const peeled = `${"c".repeat(40)}\trefs/tags/v7.0.1\n${CHECKOUT}\trefs/tags/v7.0.1^{}\n`;
    expect(checkPinAgainstTag(use, peeled)).toBeNull();
  });

  it("reports a pin that is not the tag's commit, and a missing tag", () => {
    expect(checkPinAgainstTag(use, `${"d".repeat(40)}\trefs/tags/v7.0.1\n`)?.message).toBe(
      `actions/checkout@${CHECKOUT} is not v7.0.1, which is ${"d".repeat(40)}`,
    );
    expect(checkPinAgainstTag(use, "")?.message).toBe("actions/checkout has no tag v7.0.1");
  });
});

describe("distinctPins", () => {
  it("lists each repository, SHA and tag once and skips local and container actions", () => {
    const uses = [...findUses("a.yml", WORKFLOW), ...findUses("b.yml", WORKFLOW)];
    expect(distinctPins(uses).map((u) => u.repository)).toEqual([
      "actions/checkout",
      "pnpm/action-setup",
      "actions/setup-node",
      "github/codeql-action",
    ]);
  });
});

describe(".github/workflows", () => {
  it("pins every action to a full SHA with a version comment", () => {
    const directory = new URL("../../../.github/workflows/", import.meta.url);
    const problems = readdirSync(directory)
      .filter((name) => name.endsWith(".yml"))
      .flatMap((name) => findUses(name, readFileSync(new URL(name, directory), "utf8")))
      .map((u) => checkPinFormat(u))
      .filter((p) => p !== null);
    expect(problems).toEqual([]);
  });
});
