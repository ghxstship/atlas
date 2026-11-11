import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  bulkUpdateMine,
  GATEWAY_BULK_RESOURCES,
  isGatewayBulkResource,
} from "../src/gateway-bulk.ts";

function rpcClient(answer: { data: unknown; error: unknown }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve(answer);
    },
  } as unknown as XosClient;
  return { db, calls };
}

describe("Gateway bulk actions", () => {
  it("submits timesheets through the person's own RPC and reads the recall that undoes it", async () => {
    const { db, calls } = rpcClient({
      data: {
        preview: false,
        committed: true,
        changed: 2,
        unchanged: 0,
        refused: [],
        inverse: [
          {
            id: "t1",
            set: { timesheet_state: "Proposed" },
            expect: { timesheet_state: "Submitted" },
          },
          {
            id: "t2",
            set: { timesheet_state: "Proposed" },
            expect: { timesheet_state: "Submitted" },
          },
        ],
      },
      error: null,
    });
    const result = await bulkUpdateMine(db, "my_timesheets", [
      { id: "t1", set: { timesheet_state: "Submitted" } },
      { id: "t2", set: { timesheet_state: "Submitted" } },
    ]);
    expect(calls).toEqual([
      {
        fn: "bulk_update_my_timesheets",
        args: {
          p_rows: [
            { id: "t1", set: { timesheet_state: "Submitted" } },
            { id: "t2", set: { timesheet_state: "Submitted" } },
          ],
          p_preview: false,
        },
      },
    ]);
    expect(result.ok && result.data.committed).toBe(true);
    expect(result.ok ? result.data.inverse[0]?.set : null).toEqual({ timesheet_state: "Proposed" });
  });

  it("previews with a reason and reports refused rows with their rule", async () => {
    const { db, calls } = rpcClient({
      data: {
        preview: true,
        committed: false,
        changed: 1,
        unchanged: 0,
        refused: [{ id: "a2", rule: "application_offered", message: "Answer the offer." }],
        inverse: [],
      },
      error: null,
    });
    const result = await bulkUpdateMine(
      db,
      "my_applications",
      [{ id: "a2", set: { application_state: "Withdrawn" } }],
      { preview: true, reason: "No longer free." },
    );
    expect(calls[0]?.fn).toBe("bulk_update_my_applications");
    expect(calls[0]?.args["p_preview"]).toBe(true);
    expect(calls[0]?.args["p_reason"]).toBe("No longer free.");
    expect(result.ok ? result.data.refused : []).toEqual([
      { id: "a2", rule: "application_offered", message: "Answer the offer." },
    ]);
  });

  it("maps each resource to its RPC and returns a refusal of the call as an error", async () => {
    const { db, calls } = rpcClient({
      data: null,
      error: { code: "XR001", message: "bulk_empty: Select at least one row.", hint: "bulk_empty" },
    });
    const result = await bulkUpdateMine(db, "my_engagement_documents", []);
    expect(calls[0]?.fn).toBe("bulk_update_my_engagement_documents");
    expect(result.ok).toBe(false);
  });

  it("knows its resources", () => {
    expect(GATEWAY_BULK_RESOURCES).toEqual([
      "my_timesheets",
      "my_engagement_documents",
      "my_applications",
      "engaged_allocation_assignments",
    ]);
    expect(isGatewayBulkResource("my_timesheets")).toBe(true);
    expect(isGatewayBulkResource("records")).toBe(false);
  });
});
