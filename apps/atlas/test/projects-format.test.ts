import { PROJECT_STATES } from "@xos/data/projects";
import { describe, expect, it } from "vitest";
import { PROJECT_STATE_ORDER } from "../lib/projects/format";

describe("project states for client components", () => {
  it("match the app.project_state enum in order", () => {
    expect(PROJECT_STATE_ORDER).toEqual(PROJECT_STATES);
  });
});
