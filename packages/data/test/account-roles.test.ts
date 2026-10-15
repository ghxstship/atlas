import { describe, expect, it } from "vitest";
import { removeAccountRole } from "../src/account-roles.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

describe("removeAccountRole", () => {
  it("removes a role through app.remove_account_role", async () => {
    const { db, calls } = fakeClient({ "rpc:remove_account_role": [okResponse(null)] });
    expect(await removeAccountRole(db, "r1")).toEqual({ ok: true, data: null });
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_account_membership_role_id: "r1" }]]);
  });

  it("returns the refusal when the last Account Owner would go", async () => {
    const { db } = fakeClient({
      "rpc:remove_account_role": [
        errorResponse(
          "XR001",
          "account_last_owner: An account keeps one Account Owner.",
          "account_last_owner",
        ),
      ],
    });
    const result = await removeAccountRole(db, "r1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("refusal");
  });
});
