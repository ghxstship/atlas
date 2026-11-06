import { describe, expect, it } from "vitest";
import { progressCellHref } from "../components/advancing/progress-links";

/**
 * Where a Packets cell of Advancing > Progress opens (R11). The submissions queue defaults to unreviewed answers and
 * selects its first when the id is not in the list, so a reviewed cell must name a filter that holds its answer.
 */
describe("progressCellHref", () => {
  const path = "/org/p/NWS/advancing";
  const cell = { packetId: "packet", latestSubmissionId: "answer" };

  it("opens an answer awaiting review in the default queue", () => {
    expect(progressCellHref(path, { ...cell, state: "Awaiting Review" })).toBe(
      `${path}?section=submissions&peek=answer`,
    );
  });

  it.each(["Accepted", "Returned", "Complete"] as const)(
    "opens a %s answer with the filter that holds it",
    (state) => {
      expect(progressCellHref(path, { ...cell, state })).toBe(
        `${path}?section=submissions&filter=all&peek=answer`,
      );
    },
  );

  it("opens the packet while there is no answer", () => {
    expect(progressCellHref(path, { ...cell, latestSubmissionId: null, state: "Missing" })).toBe(
      `${path}?section=packets&peek=packet`,
    );
  });
});
