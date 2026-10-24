import { describe, expect, it } from "vitest";
import { enabledFlags, US_COMPLIANCE_FORMS_FLAG } from "../src/feature-flags.ts";
import { errorResponse, okResponse } from "./fake-client.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

/** Feature flags as an org's members see them (0540), and the flag the OSHA forms and the WH-347 sit behind (1593). */
describe("feature flags", () => {
  it("names the flag of the US compliance forms as migration 1593 adds it", () => {
    expect(US_COMPLIANCE_FORMS_FLAG).toBe("compliance.us_forms");
  });

  it("reads the flags that are on for the org", async () => {
    const { db, calls } = moduleClient({
      "rpc:org_feature_flags": [
        okResponse([
          { flag_key: "compliance.us_forms", enabled: false },
          { flag_key: "imports.google_sheets", enabled: true },
        ]),
      ],
    });
    const flags = await enabledFlags(db, "org-1");
    expect(flags.ok && [...flags.data]).toEqual(["imports.google_sheets"]);
    expect(stepsOf(calls[0], "args")).toEqual([[{ p_org_id: "org-1" }]]);
  });

  it("reads none for someone outside the org, and passes a refusal on", async () => {
    const outside = moduleClient({ "rpc:org_feature_flags": [okResponse(null)] });
    const none = await enabledFlags(outside.db, "org-1");
    expect(none.ok && none.data.size).toBe(0);
    const broken = moduleClient({
      "rpc:org_feature_flags": [errorResponse("42501", "permission denied")],
    });
    expect((await enabledFlags(broken.db, "org-1")).ok).toBe(false);
  });
});
