import { describe, expect, it } from "vitest";
import {
  groupOutsideAccess,
  listOutsideAccess,
  type OutsideAccessRow,
} from "../src/outside-access.ts";
import { fakeClient, okResponse } from "./fake-client.ts";

const row = (source: OutsideAccessRow["source"], sourceId: string): OutsideAccessRow => ({
  source,
  sourceId,
  label: sourceId,
  recipientEmail: null,
  tokenHint: null,
  state: "Active",
  expiresAt: null,
  openCount: null,
  lastOpenedAt: null,
  createdAt: "x",
});

describe("outside access", () => {
  it("always filters by project, since a file link's project is looked up per row", async () => {
    const { db: client, calls } = fakeClient({
      "from:project_outside_access": [
        okResponse([
          {
            source: "File link",
            source_id: "s",
            label: "Plan",
            recipient_email: null,
            token_hint: null,
            link_state: "Active",
            expires_at: "x",
            open_count: 3,
            last_opened_at: "y",
            created_at: "z",
          },
        ]),
      ],
    });
    expect(await listOutsideAccess(client, "p")).toMatchObject({
      data: [{ source: "File link", openCount: 3, lastOpenedAt: "y" }],
    });
    expect(
      calls[0]?.steps.some(
        ([step, args]) => step === "eq" && args[0] === "project_id" && args[1] === "p",
      ),
    ).toBe(true);
  });

  it("groups in the section's fixed order and leaves out empty sources", () => {
    const groups = groupOutsideAccess([
      row("Engagement", "e"),
      row("Live view link", "l"),
      row("Engagement", "f"),
    ]);
    expect(groups.map((g) => g.source)).toEqual(["Live view link", "Engagement"]);
    expect(groups[1]?.rows).toHaveLength(2);
  });
});
