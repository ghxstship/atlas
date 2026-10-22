import { describe, expect, it } from "vitest";
import {
  LEGAL_NOTICE_DAYS,
  daysUntilEffective,
  listPendingReacceptances,
} from "../src/legal-reacceptance.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/** Re-acceptance after a material change (A82, migration 1383). */
describe("re-acceptance", () => {
  it("reads the org's prompts with the org id and the person's own without one", async () => {
    const row = {
      document_slug: "terms-of-service",
      document_version: "2.0.0",
      summary: "Clearer limits of liability.",
      noticed_at: "2026-10-20T15:00:00Z",
      effective_on: "2026-11-19",
      required: false,
    };
    const { db, calls } = fakeClient({
      "rpc:pending_legal_reacceptances": [
        okResponse([row]),
        okResponse([]),
        errorResponse("42501", "permission denied"),
      ],
    });
    expect(await listPendingReacceptances(db, "org-1")).toEqual({
      ok: true,
      data: [
        {
          documentSlug: "terms-of-service",
          documentVersion: "2.0.0",
          summary: "Clearer limits of liability.",
          noticedAt: "2026-10-20T15:00:00Z",
          effectiveOn: "2026-11-19",
          required: false,
        },
      ],
    });
    expect(await listPendingReacceptances(db, null)).toEqual({ ok: true, data: [] });
    expect(calls[0]?.steps[0]?.[1][0]).toEqual({ p_org_id: "org-1" });
    expect(calls[1]?.steps[0]?.[1][0]).toEqual({});
    expect((await listPendingReacceptances(db, null)).ok).toBe(false);
  });

  it("counts the days of notice left in UTC", () => {
    const noticed = new Date("2026-10-20T23:30:00Z");
    expect(LEGAL_NOTICE_DAYS).toBe(30);
    expect(daysUntilEffective("2026-11-19", noticed)).toBe(30);
    expect(daysUntilEffective("2026-10-21", noticed)).toBe(1);
    expect(daysUntilEffective("2026-10-20", noticed)).toBe(0);
    expect(daysUntilEffective("2026-10-01", noticed)).toBe(0);
  });
});
